package com.nanless.paperdigest.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ArrowDropDown
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import org.json.JSONObject

/** Only explicitly changed keys are saved; displaying a default never rewrites an existing configuration. */
@OptIn(ExperimentalLayoutApi::class)
@Composable internal fun ModelSettings(state:UiState,controller:AppController,secret:()->Unit) {
    var freshCheckRevision by remember { mutableLongStateOf(0) }
    var draft by rememberSaveable { mutableStateOf(state.settings.toString()) }
    var changedKeys by rememberSaveable { mutableStateOf(listOf<String>()) }
    var dirty by rememberSaveable { mutableStateOf(false) }
    var advanced by rememberSaveable { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope=rememberCoroutineScope()
    val settings=JSONObject(draft)
    LaunchedEffect(state.settings.toString()){if(!dirty)draft=state.settings.toString()}
    fun change(key:String,value:Any) {
        draft=JSONObject(draft).put(key,value).toString();changedKeys=(changedKeys+key).distinct();dirty=true;freshCheckRevision++
    }
    val muse=settings.optString("model").trim().lowercase().startsWith("muse-spark-")
    Text("本机模型连接",style=MaterialTheme.typography.titleLarge)
    Text("只有你明确发送研究问题或检查连接时才会请求 API。密钥保存在 Android 安全存储，不随备份迁移。")
    OutlinedTextField(settings.optString("endpoint"),{change("endpoint",it)},Modifier.fillMaxWidth(),label={Text("API 地址")},supportingText={Text("使用服务商提供的地址；本机服务可使用回环 HTTP。")},singleLine=true)
    OutlinedTextField(settings.optString("model"),{change("model",it)},Modifier.fillMaxWidth(),label={Text("模型名称")},singleLine=true)
    ModelSettingChoice("接口协议",settings.optString("protocol","auto"),listOf("auto" to "自动识别","chat" to "Chat Completions","responses" to "Responses")){change("protocol",it)}
    Text("自动识别根据模型和完整端点选择协议；切换选项不会发起请求。",style=MaterialTheme.typography.bodySmall)
    if(muse) {
        Text("Muse 需要 HTTP CONNECT 代理",style=MaterialTheme.typography.titleSmall)
        OutlinedTextField(settings.optString("httpProxy"),{change("httpProxy",it)},Modifier.fillMaxWidth(),label={Text("HTTP CONNECT 代理（Muse 必填）")},supportingText={Text("填写不含账号密码的 http://主机:端口。")},singleLine=true)
    }
    TextButton({advanced=!advanced}){Text(if(advanced)"收起高级参数"else"展开高级参数（预算、超时与推理）")}
    if(!advanced&&settings.optString("httpProxy").isNotBlank()&&!muse)Text("已有代理配置，可在高级参数中查看；未修改的原值会保留。",style=MaterialTheme.typography.bodySmall)
    if(advanced) {
        Text("用量与等待时间",style=MaterialTheme.typography.titleMedium)
        Text("这些设置不会自动发起请求；实际发送前仍会核对用量与费用。",style=MaterialTheme.typography.bodySmall)
        listOf("maxTokens" to ("单次输出上限" to "8000"),"dailyRequests" to ("每日请求上限（UTC）" to "20"),"timeoutMs" to ("超时（毫秒）" to "180000")).forEach { (key,field)->
            OutlinedTextField(settings.optString(key,field.second),{change(key,it)},Modifier.fillMaxWidth(),label={Text(field.first)},supportingText={Text(when(key){"maxTokens"->"128–64,000 token";"dailyRequests"->"按 UTC 自然日计数；已发出的请求仍保留原始用量。";else->"1,000–600,000 毫秒；1,000 毫秒为 1 秒。原值按毫秒保存，不舍入。"})},singleLine=true)
        }
        Text("Responses 选项",style=MaterialTheme.typography.titleMedium)
        ModelSettingChoice("推理强度",settings.optString("reasoningEffort","default"),listOf("default" to "服务默认","none" to "不额外推理","minimal" to "最少","low" to "低","medium" to "中","high" to "高","xhigh" to "更高")){change("reasoningEffort",it)}
        Text("仅支持该参数的 Responses 服务会采用推理设置。",style=MaterialTheme.typography.bodySmall)
        Row(Modifier.fillMaxWidth()) {Text("Responses 流式响应",Modifier.weight(1f));Switch(settings.optBoolean("responsesStream"),{change("responsesStream",it)})}
        if(!muse) {
            Text("代理配置",style=MaterialTheme.typography.titleMedium)
            OutlinedTextField(settings.optString("httpProxy"),{change("httpProxy",it)},Modifier.fillMaxWidth(),label={Text("HTTP CONNECT 代理（Muse 必填）")},supportingText={Text("Muse 使用此配置；其他模型沿用现有直连规则。")},singleLine=true)
        }
    }
    error?.let {Text(it,color=MaterialTheme.colorScheme.error)}
    FlowRow(horizontalArrangement=Arrangement.spacedBy(8.dp)) {
        Button({
            val submitted=draft;val submittedKeys=changedKeys.toList()
            val changes=JSONObject().apply {submittedKeys.forEach {key->put(key,JSONObject(submitted).get(key))}}
            saving=true
            scope.launch {
                try {
                    controller.execute("settings.save",obj("changes" to changes))
                    if(draft==submitted){dirty=false;changedKeys=emptyList()};error=null
                }catch(cancelled:CancellationException){throw cancelled}
                catch(failure:Exception){error=if(JSONObject(submitted).optString("protocol","auto") !in setOf("auto","chat","responses"))"接口协议未保存：请明确选择自动识别或受支持的协议，原配置与草稿保留。"else failure.message?:"连接尚未保存，草稿仍保留。"}
                finally {saving=false}
            }
        },enabled=dirty&&!saving){Text(if(saving)"正在保存…"else"保存连接")}
        OutlinedButton({draft=state.settings.toString();dirty=false;changedKeys=emptyList();freshCheckRevision++},enabled=dirty&&!saving){Text("撤销更改")}
    }
    if(dirty)Text("先保存当前配置，再设置密钥或检查连接。",style=MaterialTheme.typography.bodySmall)
    OutlinedButton(secret,enabled=!dirty&&!saving&&!state.busy){Text("为已保存连接设置模型密钥…")}
    FreshStudyAction(state,controller,connectionCheck=true,draftRevision=freshCheckRevision,enabled=!dirty&&!saving&&!state.busy,label="检查当前连接（计入用量）")
}

@Composable private fun ModelSettingChoice(label:String,current:String,choices:List<Pair<String,String>>,change:(String)->Unit) {
    var expanded by remember { mutableStateOf(false) }
    Text(label,style=MaterialTheme.typography.titleSmall)
    Box {
        OutlinedButton({expanded=true},modifier=Modifier.fillMaxWidth().semantics{contentDescription="选择$label"}) {
            Text(choices.firstOrNull {it.first==current}?.second?:"保留现有值：${current.ifEmpty{"（空）"}}",Modifier.weight(1f))
            Icon(Icons.Outlined.ArrowDropDown,null)
        }
        DropdownMenu(expanded,{expanded=false}) {choices.forEach { (value,text)->DropdownMenuItem(text={Text(text)},onClick={expanded=false;change(value)})}}
    }
}
