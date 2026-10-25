package com.nanless.paperdigest.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import org.json.JSONObject

/** A confirmation belongs to one immutable original record, not the currently displayed owner. */
private data class SessionNoteIdentity(val id:String,val owner:String,val inputSHA:String,val answer:String,val question:String,val sourceJSON:String,val createdAt:String,val status:String)
private fun sessionNoteIdentity(session:JSONObject)=SessionNoteIdentity(session.optString("id"),session.optString("paperID"),session.optString("inputSHA256"),sessionAnswer(session),session.optString("question"),session.optJSONObject("source")?.toString().orEmpty(),session.optString("createdAt"),session.optString("status"))
private data class SessionNoteDraft(val identity:SessionNoteIdentity,val sessionJSON:String,val baseNoteJSON:String)

/** Reads the selected original record directly; a material/owner change retires the entire confirmation subtree. */
@Composable internal fun SessionPane(state:UiState,id:String?,controller:AppController,action:Action){
 val session=uniqueStudySession(state.sessions,id)
 if(session==null){EmptyPane("原研究记录不可用","原记录未保存或身份不唯一；没有用当前论文的其他回答替代。");return}
 val identity=sessionNoteIdentity(session)
 val currentIdentity by rememberUpdatedState(identity)
 key(identity){BoundSessionPane(state,JSONObject(session.toString()),controller,action){currentIdentity}}
}

@OptIn(ExperimentalLayoutApi::class)
@Composable private fun BoundSessionPane(state:UiState,session:JSONObject,controller:AppController,action:Action,currentIdentity:()->SessionNoteIdentity){
 val id=session.getString("id");val identity=sessionNoteIdentity(session)
 val context=androidx.compose.ui.platform.LocalContext.current
 val answer=sessionAnswer(session);val source=session.optJSONObject("source")?:JSONObject()
 var html by remember(id,answer){mutableStateOf<String?>(null)};var error by remember(id){mutableStateOf<String?>(null)}
 var expanded by remember(id){mutableStateOf(false)};var exporting by remember{mutableStateOf(false)}
 var checking by remember{mutableStateOf(false)};var saveNote by remember{mutableStateOf(false)};var saving by remember{mutableStateOf(false)}
 val scope=rememberCoroutineScope();val owner=session.optString("paperID");val isCheck=source.optString("kind")=="connection-check"||owner=="configuration-check"||owner.isBlank()
 var noteDraft by remember{mutableStateOf<SessionNoteDraft?>(null)}
 fun requireCurrentDraft(draft:SessionNoteDraft){
  require(currentIdentity()==draft.identity){"原研究上下文已变化，请重新选择并确认追加"}
  val actual=uniqueStudySession(controller.state.value.sessions,draft.identity.id)?:error("原研究记录已不可用或身份不唯一，未写入笔记")
  require(sessionNoteIdentity(actual)==draft.identity){"原研究身份或材料已变化，未混写笔记"}
 }
 LaunchedEffect(id,answer){if(answer.isNotBlank())try{html=ResearchRenderer.render(context,answer)}catch(e:Exception){if(e is CancellationException)throw e;error=e.message}}
 Column(Modifier.fillMaxSize()){
  SectionTitle(if(isCheck)"原连接检查记录" else "原研究记录",session.optString("createdAt").ifBlank{"时间未记录"}){TextButton({action("ui.tasks",JSONObject())}){Text("返回任务")}}
  Column(Modifier.heightIn(max=260.dp).verticalScroll(rememberScrollState()).padding(horizontal=20.dp),verticalArrangement=Arrangement.spacedBy(8.dp)){
   SelectionContainer{Text(session.optString("question").ifBlank{"原问题未记录"},style=MaterialTheme.typography.titleMedium)}
   Text("${jobStatus(session.optString("status"))} · ${sessionModelLabel(session)}",style=MaterialTheme.typography.bodySmall)
   Text(sessionEvidenceLabel(session),style=MaterialTheme.typography.bodySmall)
   Text("${sessionUsageLabel(session)} · ${sessionChargeLabel(session)}",style=MaterialTheme.typography.bodySmall)
   FlowRow(horizontalArrangement=Arrangement.spacedBy(6.dp)){
    TextButton({expanded=!expanded}){Text(if(expanded)"收起原依据" else "查看原依据")}
    Box{TextButton({exporting=true}){Text("导出本条记录")};DropdownMenu(exporting,{exporting=false}){listOf("research-json" to "完整研究 JSON","research-md" to "研究 Markdown","research-html" to "研究 HTML").forEach{(format,label)->DropdownMenuItem({Text(label)},{exporting=false;action("export.prepare",obj("format" to format,"sessionID" to session.getString("id")))})}}}
    if(!isCheck&&canAppendSavedSession(session))TextButton({val base=state.personal.optJSONObject("notes")?.optJSONObject(owner)?.let{JSONObject(it.toString())}?:JSONObject().put("text","").put("revision",0);noteDraft=SessionNoteDraft(identity,session.toString(),base.toString());saveNote=true;error=null}){Text("追加到原论文笔记…")}
   }
   if(expanded)SelectionContainer{Text("记录ID：${session.optString("id")}\n实际输入SHA：${session.optString("inputSHA256").ifBlank{"未记录"}}\n${source.toString(2)}",style=MaterialTheme.typography.labelSmall)}
   if(canRecoverSession(session))OutlinedButton({checking=true;error=null;scope.launch{try{controller.execute("model.recover",obj("id" to session.getString("id")))}catch(e:Exception){if(e is CancellationException)throw e;error=e.message}finally{checking=false}}},enabled=!checking&&!state.busy){Text(if(checking)"正在核对本机原材料…" else "核验已保存回答（不重新请求）")}
   error?.let{Text(it,color=MaterialTheme.colorScheme.error)}
  }
  if(html!=null)Box(Modifier.weight(1f)){StaticDocument(html!!,state.settings.optInt("font",18))}else EmptyPane("原回答尚未完整保存","已派发或中断的请求不会自动重新发送。原输入、原响应和实际用量保留。")
 }
 if(saveNote)AlertDialog(onDismissRequest={if(!saving)saveNote=false},title={Text("追加到这条记录所属论文的笔记？")},text={Column(verticalArrangement=Arrangement.spacedBy(8.dp)){Text("保留现有笔记，在末尾追加这条原问题、保存回答和来源。其他论文的笔记不受影响。");error?.let{Text(it,color=MaterialTheme.colorScheme.error)}}},confirmButton={TextButton({val draft=noteDraft?:return@TextButton;saving=true;error=null;scope.launch{try{requireCurrentDraft(draft);val base=JSONObject(draft.baseNoteJSON);val original=JSONObject(draft.sessionJSON);controller.execute("personal.note",obj("paperID" to draft.identity.owner,"baseRevision" to base.optInt("revision"),"text" to base.optString("text")+noteFromSession(original)));saveNote=false}catch(e:Exception){if(e is CancellationException)throw e;error=e.message}finally{saving=false}}},enabled=!saving){Text(if(saving)"正在保存…" else "保留原笔记并追加")}},dismissButton={TextButton({saveNote=false},enabled=!saving){Text("取消")}})
}
