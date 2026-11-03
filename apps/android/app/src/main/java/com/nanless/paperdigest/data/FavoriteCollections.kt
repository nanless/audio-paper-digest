package com.nanless.paperdigest.data

import com.nanless.paperdigest.protocols.ClientProtocols
import org.json.JSONArray
import org.json.JSONObject
import java.text.Normalizer
import java.time.Instant
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeFormatterBuilder
import java.util.UUID

/** Optional personal-library metadata. Membership always comes from the original favorites array. */
object FavoriteCollections {
    private const val family="paperdigest-favorite-collections"
    private fun knownHeader(value:JSONObject)=ClientProtocols.hasValidHeader(value,family,if(value.has("version")) "version" else "contract")
    private fun opaqueHistoricalFuture(value:JSONObject):Boolean {
        if(!value.has("version"))return false
        return integer(value.opt("version"),"收藏分类版本")>1&&
            listOf("contract","schemaFingerprint","schemaVersion","policyVersion","__proto__").none(value::has)
    }
    const val KEY="favoriteCollections"
    const val MAX_FOLDERS=200
    private val uuid=Regex("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
    private val utc=Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{1,9})?Z")
    private val milliseconds=DateTimeFormatterBuilder().appendInstant(3).toFormatter()
    data class Folder(val id:String,val name:String,val createdAt:String)
    data class Item(val addedAt:String?,val folderIDs:Set<String>)
    data class View(val revision:Int,val folders:List<Folder>,val items:Map<String,Item>,val readOnly:Boolean)

    fun instant(value:String):Instant {
        require(utc.matches(value)) { "收藏时间必须是 UTC ISO 日期" }
        require(value.substring(0,4).toInt() in 1..9999) { "收藏时间年份无效" }
        // LocalDateTime rejects invalid calendar dates, 24:00 and leap-second normalization.
        LocalDateTime.parse(value.removeSuffix("Z"),DateTimeFormatter.ISO_LOCAL_DATE_TIME)
        return Instant.parse(value)
    }
    fun normalizeName(value:String):String {
        val name=Normalizer.normalize(value.trim(),Normalizer.Form.NFC)
        require(name.isNotEmpty()&&name.toByteArray(Charsets.UTF_8).size<=128) { "分类名称不能为空，且最多 128 字节" }
        require(name.none { it.code in 0..31||it.code in 127..159 }) { "分类名称不能包含控制字符" }
        return name
    }
    private fun integer(value:Any?,label:String):Int {
        val n=value as? Number?:throw IllegalArgumentException("$label 无效")
        val long=n.toLong()
        require(long in 0..Int.MAX_VALUE.toLong()&&n.toDouble()==long.toDouble()) { "$label 无效" }
        return long.toInt()
    }
    private fun id(value:String):String= value.also { require(it.isNotBlank()&&it.toByteArray(Charsets.UTF_8).size<=256) { "收藏论文身份无效" } }
    private fun folderID(value:String):String=value.also { require(uuid.matches(it)) { "收藏分类身份无效" } }
    private fun strings(array:JSONArray):List<String> = (0 until array.length()).map { index->
        array.get(index) as? String?:throw IllegalArgumentException("收藏身份必须是字符串")
    }
    fun paperIDs(array:JSONArray):List<String> {
        require(array.length()<=100_000) { "收藏论文数量超过范围" }
        return strings(array).map(::id)
    }
    fun validateOptional(personal:JSONObject) {
        if(!personal.has(KEY))return
        val metadata=personal.opt(KEY) as? JSONObject?:throw IllegalArgumentException("收藏分类资料无效")
        require(!personal.has("schema")||metadata.has("version")){"原格式研究目录不能混入新格式收藏分类"}
        if(opaqueHistoricalFuture(metadata))return // Existing unknown numeric shapes remain read-only.
        require(knownHeader(metadata)) { "收藏分类版本无效" }
        integer(metadata.opt("revision"),"收藏分类修订")
        val folders=metadata.opt("folders") as? JSONArray?:throw IllegalArgumentException("收藏分类目录无效")
        val items=metadata.opt("items") as? JSONObject?:throw IllegalArgumentException("收藏分类条目无效")
        require(folders.length()<=MAX_FOLDERS&&items.length()<=100_000) { "收藏分类数量超过范围" }
        val folderIDs=HashSet<String>();val names=HashSet<String>()
        for(index in 0 until folders.length()) {
            val folder=folders.getJSONObject(index)
            require(folderIDs.add(folderID(folder.get("id") as? String?:error("收藏分类身份无效")))) { "收藏分类身份重复" }
            val name=folder.get("name") as? String?:error("收藏分类名称无效")
            require(name==normalizeName(name)&&names.add(name)) { "收藏分类名称未规范化或重复" }
            instant(folder.get("createdAt") as? String?:error("收藏分类创建时间无效"))
        }
        items.keys().forEach { key->
            id(key);val item=items.getJSONObject(key)
            require(item.has("addedAt")) { "收藏时间字段缺失" }
            if(!item.isNull("addedAt"))instant(item.get("addedAt") as? String?:error("收藏时间无效"))
            val assigned=strings(item.getJSONArray("folderIDs"))
            require(assigned.size==assigned.toSet().size&&assigned.all { it in folderIDs }) { "收藏分类引用不存在或重复" }
        }
        // Orphan items can remain after an older app edits the flat favorites array. Never revive them.
    }
    fun view(personal:JSONObject):View {
        validateOptional(personal)
        val metadata=personal.optJSONObject(KEY)?:return View(0,emptyList(),emptyMap(),false)
        if(!knownHeader(metadata))return View(0,emptyList(),emptyMap(),true)
        val favorites=personal.optJSONArray("favorites")?.let(::strings)?.toSet().orEmpty()
        val folders=metadata.getJSONArray("folders").objects().map { Folder(it.getString("id"),it.getString("name"),it.getString("createdAt")) }
        val items=metadata.getJSONObject("items")
        return View(metadata.getInt("revision"),folders,items.keys().asSequence().filter { it in favorites }.associateWith { key->
            val item=items.getJSONObject(key);Item(if(item.isNull("addedAt"))null else item.getString("addedAt"),strings(item.getJSONArray("folderIDs")).toSet())
        },false)
    }
    internal fun editable(personal:JSONObject):JSONObject {
        validateOptional(personal)
        val existing=personal.optJSONObject(KEY)
        if(existing!=null&&!knownHeader(existing))
            throw AppFailure("upgrade","收藏分类由更新版本创建；请升级应用后编辑，当前收藏仍可阅读。")
        if(existing!=null)return existing
        val header=if(!personal.has("schema")&&PersonalStore.validPersonalHeader(personal))ClientProtocols.record(family)
        else ClientProtocols.historicalHeader(family,"optional-folders-with-flat-membership",null)
        return header.put("revision",0).put("folders",JSONArray()).put("items",JSONObject())
    }
    private fun changed(personal:JSONObject,metadata:JSONObject):Int {
        val revision=integer(metadata.opt("revision"),"收藏分类修订")
        require(revision<Int.MAX_VALUE) { "收藏分类修订已达上限，请先导出完整备份" }
        metadata.put("revision",revision+1);personal.put(KEY,metadata)
        validateOptional(personal)
        return revision+1
    }
    /** The caller owns an unpublished native copy under its storage lock. No passed JSON grants source access. */
    internal fun replaceList(personal:JSONObject,key:String,ids:List<String>):JSONObject {
        require(key in setOf("favorites","reading")&&ids.size<=100_000)
        val desired=ids.toSortedSet()
        val old=strings(personal.getJSONArray(key)).toSet()
        (desired-old).forEach(::id)
        val metadata=if(key=="favorites")editable(personal) else null
        if(desired==old)return JSONObject().put("saved",true).put("changed",false).put("revision",metadata?.optInt("revision",0)?:0)
        if(metadata!=null) {
            val items=metadata.getJSONObject("items")
            // Drop only metadata for no-longer-favorite IDs. Unrelated known/unknown fields remain intact.
            items.keys().asSequence().toList().filter { it !in desired }.forEach(items::remove)
            val timestamp=milliseconds.format(Instant.now())
            (desired-old).forEach { keyID->
                val entry=items.optJSONObject(keyID)?:JSONObject()
                entry.put("addedAt",timestamp).put("folderIDs",JSONArray());items.put(keyID,entry)
            }
        }
        personal.put(key,JSONArray(desired))
        val revision=metadata?.let { changed(personal,it) }?:0
        return JSONObject().put("saved",true).put("changed",true).put("revision",revision)
    }
    internal fun editList(personal:JSONObject,key:String,action:String,ids:List<String>):JSONObject {
        require(key in setOf("favorites","reading")&&action in setOf("add","remove","toggle")&&ids.size<=100_000)
        val selected=ids.map(::id).toSet();val current=strings(personal.getJSONArray(key)).toMutableSet()
        when(action){"add"->current.addAll(selected);"remove"->current.removeAll(selected);"toggle"->selected.forEach { if(!current.remove(it))current.add(it) }}
        return replaceList(personal,key,current.toList())
    }
    internal fun edit(personal:JSONObject,payload:JSONObject):JSONObject {
        val metadata=editable(personal)
        val revision=integer(metadata.opt("revision"),"收藏分类修订")
        if(integer(payload.opt("expectedRevision"),"预期收藏分类修订")!=revision)
            throw AppFailure("conflict","收藏分类已在其他操作中改变；请重新打开分类后再试，原收藏保留。")
        val action=payload.getString("action");val folders=metadata.getJSONArray("folders");val items=metadata.getJSONObject("items")
        var didChange=false;var resultFolder:String?=null
        fun locate(folderID:String):JSONObject=folders.objects().singleOrNull { it.getString("id")==folderID }?:throw IllegalArgumentException("收藏分类不存在，请刷新分类")
        fun uniqueName(name:String,except:String?=null) { require(folders.objects().none { it.getString("id")!=except&&it.getString("name")==name }) { "分类名称已存在" } }
        when(action) {
            "folder.create"->{
                val name=normalizeName(payload.getString("name"));uniqueName(name);require(folders.length()<MAX_FOLDERS) { "最多创建 $MAX_FOLDERS 个收藏分类" }
                val newID=UUID.randomUUID().toString();folders.put(JSONObject().put("id",newID).put("name",name).put("createdAt",milliseconds.format(Instant.now())))
                resultFolder=newID;didChange=true
            }
            "folder.rename"->{
                val selected=folderID(payload.getString("folderID"));val folder=locate(selected);val name=normalizeName(payload.getString("name"));uniqueName(name,selected)
                if(folder.getString("name")!=name){folder.put("name",name);didChange=true};resultFolder=selected
            }
            "folder.delete"->{
                val selected=folderID(payload.getString("folderID"))
                if(folders.objects().any { it.getString("id")==selected }) {
                    metadata.put("folders",JSONArray(folders.objects().filter { it.getString("id")!=selected }))
                    items.keys().forEach { key->val item=items.getJSONObject(key);item.put("folderIDs",JSONArray(strings(item.getJSONArray("folderIDs")).filter { it!=selected })) }
                    didChange=true
                }
            }
            "items.assign"->{
                val ids=paperIDs(payload.getJSONArray("ids")).toSet()
                val rawFolders=payload.getJSONArray("folderIDs");require(rawFolders.length()<=MAX_FOLDERS) { "收藏分类数量超过范围" }
                val assigned=strings(rawFolders).map(::folderID).toSet();assigned.forEach(::locate)
                val mode=payload.getString("mode");require(mode in setOf("add","remove","replace")) { "收藏分类方式无效" }
                require(!payload.has("addMissing")||payload.opt("addMissing") is Boolean) { "是否同时收藏必须明确选择" }
                val favorites=strings(personal.getJSONArray("favorites")).toMutableSet()
                require(payload.optBoolean("addMissing",false)||ids.all { it in favorites }) { "所选论文尚未收藏；请明确选择同时收藏并分类" }
                val timestamp=milliseconds.format(Instant.now())
                ids.forEach { key->
                    val existed=key in favorites;val previous=items.optJSONObject(key)
                    val oldFolders=if(existed)previous?.getJSONArray("folderIDs")?.let(::strings)?.toSet().orEmpty() else emptySet()
                    val next=when(mode){"add"->oldFolders+assigned;"remove"->oldFolders-assigned;else->assigned}
                    if(!existed||next!=oldFolders) {
                        val entry=previous?:JSONObject().put("addedAt",JSONObject.NULL)
                        if(!existed){favorites+=key;entry.put("addedAt",timestamp)}
                        entry.put("folderIDs",JSONArray(next.sorted()));items.put(key,entry);didChange=true
                    }
                }
                require(favorites.size<=100_000)
                if(didChange)personal.put("favorites",JSONArray(favorites.sorted()))
            }
            else->throw IllegalArgumentException("收藏分类操作无效")
        }
        val nextRevision=if(didChange)changed(personal,metadata)else revision
        return JSONObject().put("saved",true).put("changed",didChange).put("revision",nextRevision).apply { resultFolder?.let { put("folderID",it) } }
    }
}
