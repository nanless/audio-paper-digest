package com.nanless.paperdigest.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.DeleteOutline
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.nanless.paperdigest.data.FavoriteCollections
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

@Composable internal fun FavoriteFolderManager(view:FavoriteCollections.View,controller:AppController,close:()->Unit) {
    var name by rememberSaveable { mutableStateOf("") }
    var editing by rememberSaveable { mutableStateOf<String?>(null) }
    var deleting by remember { mutableStateOf<FavoriteCollections.Folder?>(null) }
    var expectedRevision by rememberSaveable { mutableIntStateOf(view.revision) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope=rememberCoroutineScope()
    val scroll=rememberScrollState()
    fun submit(payload:JSONObject) {
        busy=true;error=null
        scope.launch {
            try {
                val result=controller.execute("personal.favorite.edit",payload.put("expectedRevision",expectedRevision))
                expectedRevision=result.getInt("revision");name="";editing=null;deleting=null
            }catch(cancelled:CancellationException){throw cancelled}
            catch(failure:Exception){deleting=null;error=failure.message?:"分类尚未保存，原收藏保留。";scroll.scrollTo(0)}
            finally {busy=false}
        }
    }
    fun reload() {
        busy=true
        scope.launch {
            try {
                controller.execute("app.bootstrap",JSONObject())
                val current=FavoriteCollections.view(controller.state.value.personal)
                expectedRevision=current.revision;error=null
                if(current.folders.none { it.id==editing })editing=null
            }catch(cancelled:CancellationException){throw cancelled}
            catch(failure:Exception){error=failure.message?:"当前分类未能重新读取，原草稿保留。"}
            finally {busy=false}
        }
    }
    AlertDialog(onDismissRequest={if(!busy)close()},title={Text("管理收藏分类")},text={
        Column(Modifier.heightIn(max=560.dp).verticalScroll(scroll),verticalArrangement=Arrangement.spacedBy(12.dp)) {
            Text("一篇论文可以属于多个分类。删除分类只移除归类，论文仍保留在收藏中。")
            error?.let {
                Text(it,color=MaterialTheme.colorScheme.error)
                TextButton({reload()},enabled=!busy){Text("重新读取当前分类")}
            }
            if(view.readOnly)Text("这些分类由更新版本创建，请升级应用后编辑。现有收藏仍可阅读。")
            Text("${view.folders.size} / ${FavoriteCollections.MAX_FOLDERS} 个分类",style=MaterialTheme.typography.labelMedium)
            view.folders.forEach { folder->
                Row(Modifier.fillMaxWidth(),verticalAlignment=Alignment.CenterVertically) {
                    Text(folder.name,Modifier.weight(1f))
                    IconButton({editing=folder.id;name=folder.name;error=null},enabled=!busy&&!view.readOnly){Icon(Icons.Outlined.Edit,"重命名分类：${folder.name}")}
                    IconButton({deleting=folder},enabled=!busy&&!view.readOnly){Icon(Icons.Outlined.DeleteOutline,"删除分类：${folder.name}")}
                }
            }
            OutlinedTextField(name,{name=it},Modifier.fillMaxWidth(),label={Text(if(editing==null)"新分类名称" else "分类新名称")},singleLine=true,enabled=!busy&&!view.readOnly)
            Row(horizontalArrangement=Arrangement.spacedBy(8.dp)) {
                Button({submit(obj("action" to if(editing==null)"folder.create" else "folder.rename","name" to name).apply { editing?.let { put("folderID",it) } })},enabled=!busy&&!view.readOnly&&name.isNotBlank()&&(editing!=null||view.folders.size<FavoriteCollections.MAX_FOLDERS)) {Text(if(editing==null)"创建分类" else "保存名称")}
                if(editing!=null)TextButton({editing=null;name=""},enabled=!busy){Text("取消重命名")}
            }
        }
    },confirmButton={TextButton(close,enabled=!busy){Text("完成")}})
    deleting?.let { folder->
        AlertDialog(onDismissRequest={if(!busy)deleting=null},title={Text("删除“${folder.name}”？")},text={Text("只移除这个分类及其归类；全部论文仍在收藏中。")},confirmButton={TextButton({submit(obj("action" to "folder.delete","folderID" to folder.id))},enabled=!busy){Text("删除分类，保留收藏")}},dismissButton={TextButton({deleting=null},enabled=!busy){Text("取消")}})
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable internal fun FavoriteAssignmentDialog(view:FavoriteCollections.View,favoriteIDs:Set<String>,ids:List<String>,controller:AppController,close:()->Unit,initialAddMissing:Boolean=false) {
    val selection=remember(ids){ids.distinct()}
    var folders by rememberSaveable { mutableStateOf(listOf<String>()) }
    var mode by rememberSaveable { mutableStateOf("add") }
    var addMissing by rememberSaveable { mutableStateOf(initialAddMissing) }
    var name by rememberSaveable { mutableStateOf("") }
    var expectedRevision by rememberSaveable { mutableIntStateOf(view.revision) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope=rememberCoroutineScope()
    val missing=selection.count { it !in favoriteIDs }
    fun submit(payload:JSONObject,created:Boolean=false) {
        busy=true;error=null
        scope.launch {
            try {
                val result=controller.execute("personal.favorite.edit",payload.put("expectedRevision",expectedRevision))
                expectedRevision=result.getInt("revision")
                if(created){folders=(folders+result.getString("folderID")).distinct();name=""}else close()
            }catch(cancelled:CancellationException){throw cancelled}
            catch(failure:Exception){error=failure.message?:"分类尚未保存，原收藏保留。"}
            finally {busy=false}
        }
    }
    fun reload() {
        busy=true
        scope.launch {
            try {
                controller.execute("app.bootstrap",JSONObject())
                val current=FavoriteCollections.view(controller.state.value.personal)
                expectedRevision=current.revision;folders=folders.filter { id->current.folders.any { it.id==id } };error=null
            }catch(cancelled:CancellationException){throw cancelled}
            catch(failure:Exception){error=failure.message?:"当前分类未能重新读取，原选择保留。"}
            finally {busy=false}
        }
    }
    AlertDialog(onDismissRequest={if(!busy)close()},title={Text("整理 ${selection.size} 篇收藏")},text={
        Column(Modifier.heightIn(max=560.dp).verticalScroll(rememberScrollState()),verticalArrangement=Arrangement.spacedBy(12.dp)) {
            Text("默认添加分类，保留这些论文原有的其他分类。")
            if(view.readOnly)Text("这些分类由更新版本创建，请升级应用后编辑。现有收藏仍可阅读。")
            FlowRow(horizontalArrangement=Arrangement.spacedBy(6.dp)) {
                listOf("add" to "添加分类","remove" to "移出分类","replace" to "重新分类").forEach { (value,label)->FilterChip(mode==value,{mode=value},enabled=!busy&&!view.readOnly,label={Text(label)}) }
            }
            if(mode=="replace")Text("本次选择将替换原有分类；不选任何分类时，归入“未分类”。",color=MaterialTheme.colorScheme.tertiary)
            if(view.folders.isEmpty())Text("还没有分类，可在下方直接创建。")
            view.folders.forEach { folder->
                Row(Modifier.fillMaxWidth().heightIn(min=48.dp).toggleable(value=folder.id in folders,enabled=!busy&&!view.readOnly,role=Role.Checkbox,onValueChange={checked->folders=if(checked)(folders+folder.id).distinct()else folders-folder.id}).semantics{contentDescription="收藏分类：${folder.name}"},verticalAlignment=Alignment.CenterVertically) {
                    Checkbox(folder.id in folders,null,enabled=!busy&&!view.readOnly)
                    Text(folder.name,Modifier.weight(1f))
                    val already=selection.count { folder.id in view.items[it]?.folderIDs.orEmpty() }
                    if(already>0)Text("已有 $already 篇",style=MaterialTheme.typography.labelSmall)
                }
            }
            if(missing>0)Row(Modifier.fillMaxWidth().heightIn(min=48.dp).toggleable(value=addMissing,enabled=!busy&&!view.readOnly,role=Role.Checkbox,onValueChange={addMissing=it}),verticalAlignment=Alignment.CenterVertically) {
                Checkbox(addMissing,null,enabled=!busy&&!view.readOnly)
                Text("同时收藏尚未收藏的 $missing 篇",Modifier.weight(1f))
            }
            OutlinedTextField(name,{name=it},Modifier.fillMaxWidth(),label={Text("直接新建分类")},singleLine=true,enabled=!busy&&!view.readOnly)
            TextButton({submit(obj("action" to "folder.create","name" to name),created=true)},enabled=!busy&&!view.readOnly&&name.isNotBlank()&&view.folders.size<FavoriteCollections.MAX_FOLDERS){Text("创建并选中分类")}
            error?.let {
                Text(it,color=MaterialTheme.colorScheme.error)
                TextButton({reload()},enabled=!busy){Text("重新读取当前分类")}
            }
        }
    },confirmButton={Button({submit(obj("action" to "items.assign","ids" to JSONArray(selection),"folderIDs" to JSONArray(folders),"mode" to mode,"addMissing" to addMissing))},enabled=!busy&&!view.readOnly&&selection.isNotEmpty()&&(missing==0||addMissing)&&(mode=="replace"||folders.isNotEmpty())){Text(if(busy)"正在保存…" else if(missing>0&&addMissing)"收藏并保存分类" else "保存分类")}},dismissButton={TextButton(close,enabled=!busy){Text("取消")}})
}
