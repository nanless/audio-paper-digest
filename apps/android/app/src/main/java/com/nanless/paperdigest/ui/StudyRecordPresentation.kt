package com.nanless.paperdigest.ui

import org.json.JSONObject
import java.math.BigInteger
import java.math.BigDecimal
import java.text.NumberFormat
import java.util.Locale

/** Read-only presentation. Missing values, conflicting aliases and navigation never grant a paid request. */
internal data class RecordedTokens(val value:Long?,val problem:Boolean=false)
internal data class StudyUsagePresentation(val input:RecordedTokens,val output:RecordedTokens,val total:RecordedTokens) {
 fun label():String {
  fun shown(value:RecordedTokens)=value.value?.let{NumberFormat.getIntegerInstance(Locale.ROOT).format(it)}?:"未知"
  val fields="输入：${shown(input)} · 输出：${shown(output)} · 合计：${shown(total)} Token"
  return fields+if(input.problem||output.problem||total.problem)"（原用量字段冲突或无效，未补算）" else ""
 }
}
private fun recordedInteger(value:Any?):Long?=when(value){
 is Byte->value.toLong().takeIf{it>=0};is Short->value.toLong().takeIf{it>=0};is Int->value.toLong().takeIf{it>=0};is Long->value.takeIf{it>=0}
 is BigInteger->runCatching{value.longValueExact()}.getOrNull()?.takeIf{it>=0}
 else->null
}
private fun recordedTokens(usage:JSONObject?,aliases:List<String>):RecordedTokens {
 if(usage==null)return RecordedTokens(null)
 val present=aliases.filter{usage.has(it)};if(present.isEmpty())return RecordedTokens(null)
 val values=present.map{recordedInteger(usage.opt(it))}
 if(values.any{it==null}||values.distinct().size!=1)return RecordedTokens(null,true)
 return RecordedTokens(values.singleOrNull()?:values.first())
}
internal fun studyUsage(usage:JSONObject?):StudyUsagePresentation {
 val input=recordedTokens(usage,listOf("input_tokens","prompt_tokens","inputTokens","promptTokens"))
 val output=recordedTokens(usage,listOf("output_tokens","completion_tokens","outputTokens","completionTokens"))
 var total=recordedTokens(usage,listOf("total_tokens","totalTokens"))
 if(input.value!=null&&output.value!=null&&total.value!=null&&BigInteger.valueOf(input.value).add(BigInteger.valueOf(output.value))!=BigInteger.valueOf(total.value))total=RecordedTokens(null,true)
 return StudyUsagePresentation(input,output,total)
}
internal fun sessionUsageLabel(session:JSONObject):String=studyUsage(session.optJSONObject("usage")).label()
private fun text(record:JSONObject,key:String):String?=(record.opt(key) as? String)
internal fun uniqueStudySession(sessions:List<JSONObject>,id:String?):JSONObject? {
 if(id.isNullOrBlank())return null
 val matching=sessions.filter{text(it,"id")==id}
 return matching.singleOrNull()?.takeIf{sessionOwnerConsistent(it)}
}
/** Build once for a reader list; ambiguous IDs stay excluded without an O(n²) lookup per row. */
internal fun uniqueStudySessionIndex(sessions:List<JSONObject>):Map<String,JSONObject> {
 val seen=HashSet<String>();val unique=LinkedHashMap<String,JSONObject>()
 for(session in sessions){val id=text(session,"id")?.takeIf{it.isNotBlank()}?:continue;if(!seen.add(id)){unique.remove(id);continue};if(sessionOwnerConsistent(session))unique[id]=session}
 return unique
}
private fun sessionOwnerConsistent(session:JSONObject):Boolean {
 val owner=text(session,"paperID")?:return false
 val source=session.optJSONObject("source")?:return true
 if(source.has("paperID")&&!source.isNull("paperID")) {
  val declared=text(source,"paperID")?:return false
  if(declared!=owner)return false
 }
 return true
}
private fun declaredSessionID(job:JSONObject):Pair<String?,Boolean> {
 val names=listOf(job to "sessionID",(job.optJSONObject("result")?:JSONObject()) to "sessionID")
 val ids=names.filter{it.first.has(it.second)&&!it.first.isNull(it.second)}.map{(record,key)->text(record,key)}
 if(ids.any{it.isNullOrBlank()}||ids.distinct().size>1)return null to false
 return ids.firstOrNull() to true
}
private fun jobRoute(job:JSONObject):String? {
 if(listOf("kind","command").any{job.has(it)&&!job.isNull(it)&&text(job,it)==null})return null
 val kind=text(job,"kind")?.takeIf{it.isNotBlank()};val command=text(job,"command")?.takeIf{it.isNotBlank()}
 if(kind!=null&&command!=null&&kind!=command)return null
 return kind?:command
}
internal fun isModelTask(job:JSONObject):Boolean=listOf(text(job,"kind"),text(job,"command")).any{it in setOf("model.run","model.check")}
/** A direct, unique record pointer is navigation only; it is not this task's provenance or fee authority. */
internal fun jobSession(job:JSONObject,sessions:List<JSONObject>):JSONObject? {
 val route=jobRoute(job)
 if(route in setOf("export.prepare","retained.export.prepare","export.save","export.retained.prepare","export.retained.save"))return null
 val (explicit,consistent)=declaredSessionID(job);if(!consistent)return null
 if(explicit==null&&route!=null&&route !in setOf("model.run","model.check"))return null
 val session=uniqueStudySession(sessions,explicit?:text(job,"id"))?:return null
 val owner=text(session,"paperID")?:return null
 for(record in listOf(job,job.optJSONObject("result")?:JSONObject())) {
  if(record.has("paperID")&&!record.isNull("paperID")) {
   val declared=text(record,"paperID")?:return null
   if(declared.isNotEmpty()&&declared!=owner)return null
  }
 }
 return session
}
private enum class RecordedPurpose { RESEARCH,CHECK,UNKNOWN }
private fun recordedPurpose(session:JSONObject):RecordedPurpose {
 if(!sessionOwnerConsistent(session))return RecordedPurpose.UNKNOWN
 val owner=text(session,"paperID")?:return RecordedPurpose.UNKNOWN
 val declaredContract=session.has("inputContract")
 val inputContract=if(declaredContract)text(session,"inputContract")?:return RecordedPurpose.UNKNOWN else null
 if(declaredContract&&inputContract!="android-study-input-v1")return RecordedPurpose.UNKNOWN
 val kind=text(session,"kind");val source=session.optJSONObject("source");val sourceKind=source?.let{text(it,"kind")}
 if(kind=="study"&&owner=="configuration-check"&&sourceKind=="connection-check"&&text(session,"inputContract")=="android-study-input-v1")return RecordedPurpose.CHECK
 if(kind=="connection-check"&&owner.isEmpty()&&sourceKind=="connection-check"&&!declaredContract)return RecordedPurpose.CHECK
 if(kind=="study"&&owner.isNotEmpty()&&owner!="configuration-check"&&!sourceKind.isNullOrBlank()&&sourceKind!="connection-check"&&(inputContract==null||inputContract=="android-study-input-v1"))return RecordedPurpose.RESEARCH
 return RecordedPurpose.UNKNOWN
}
/** Strict task attribution requires its actual own ID, owner and request purpose, without a current-paper fallback. */
internal fun taskStudySession(job:JSONObject,sessions:List<JSONObject>):JSONObject? {
 val route=jobRoute(job);if(route !in setOf("model.run","model.check"))return null
 val session=jobSession(job,sessions)?:return null
 if(text(job,"id").isNullOrBlank()||text(job,"id")!=text(session,"id"))return null
 val owner=text(job,"paperID")?:return null
 if(owner!=text(session,"paperID"))return null
 val purpose=recordedPurpose(session)
 return session.takeIf{if(route=="model.check")purpose==RecordedPurpose.CHECK else purpose==RecordedPurpose.RESEARCH}
}
internal data class StudyTaskPresentation(val evidence:String,val usage:String,val charge:String)
internal fun studyTaskPresentation(job:JSONObject,sessions:List<JSONObject>):StudyTaskPresentation? {
 if(!isModelTask(job))return null
 if(jobRoute(job) in setOf("model.run","model.check")&&(job.opt("reused")==true||job.optJSONObject("result")?.opt("reused")==true))return StudyTaskPresentation("原任务标注复用；原材料版本以原研究记录为准", "原任务标注未新增模型请求；原记录用量不计作本次新增用量", "派发账本本页未单独核验；原请求金额未在本任务核对")
 val session=taskStudySession(job,sessions)
 return if(session==null)StudyTaskPresentation("没有唯一匹配的原研究记录，材料与版本未确认",studyUsage(null).label(),"金额未确认，不表示免费")
 else StudyTaskPresentation(sessionEvidenceLabel(session),sessionUsageLabel(session),sessionChargeLabel(session))
}
/** Requested model is configuration, never evidence that this model actually answered. */
internal fun sessionModelLabel(session:JSONObject):String {
 val actual=text(session,"actualModel")?.takeIf{it.isNotBlank()}
 if(actual!=null)return "实际模型：$actual"
 val requested=text(session,"model")?.takeIf{it.isNotBlank()}
 return if(requested!=null)"请求模型：$requested；实际模型未记录" else "请求模型与实际模型均未记录"
}
internal fun sessionAnswer(session:JSONObject):String=listOf("answer","text","response").firstNotNullOfOrNull{key->(session.opt(key) as? String)?.takeIf{it.isNotBlank()}}?:""
internal fun sessionEvidenceLabel(session:JSONObject):String {
 val source=session.optJSONObject("source")?:return "原依据未记录"
 val pages=source.optJSONArray("pages")?.let{a->(0 until a.length()).mapNotNull{recordedInteger(a.opt(it))?.takeIf{it>0}}.joinToString("、")}
 val version=text(source,"sourceVersion")?.takeIf{it.isNotBlank()}?:"原版本未标注"
 return "原依据：${text(source,"kind")?.takeIf{it.isNotBlank()}?:"类型未记录"} · $version"+(if(!pages.isNullOrEmpty())" · 物理页 $pages" else "")
}
internal fun sessionChargeLabel(session:JSONObject):String {
 val cost=session.opt("cost") as? Number
 if(session.opt("costKnown")==true&&cost!=null&&cost.toDouble().isFinite()&&cost.toDouble()>=0) {
  val decimal=runCatching{BigDecimal(cost.toString()).stripTrailingZeros().toPlainString()}.getOrNull()
  if(decimal!=null&&decimal.length<=128&&!decimal.startsWith("-"))return "原记录金额：$decimal（币种未核验）"
 }
 // A false session flag cannot prove the separate durable issued floor has no entry.
 return "金额未确认，不表示免费"
}
internal fun canAppendSavedSession(session:JSONObject):Boolean {
 val owner=text(session,"paperID")?:return false
 return sessionOwnerConsistent(session)&&owner.isNotBlank()&&owner!="configuration-check"&&text(session,"kind")!="connection-check"&&session.optJSONObject("source")?.let{text(it,"kind")}!="connection-check"&&text(session,"status") in setOf("complete","completed")&&sessionAnswer(session).isNotBlank()
}
internal fun noteFromSession(session:JSONObject):String="\n\n## 原研究记录 · ${text(session,"createdAt")?.takeIf{it.isNotBlank()}?:"时间未记录"}\n\n问题：${text(session,"question").orEmpty()}\n\n${sessionAnswer(session)}\n\n${sessionEvidenceLabel(session)}\n原记录 ID：${text(session,"id").orEmpty()}\n实际输入 SHA：${text(session,"inputSHA256")?.takeIf{it.isNotBlank()}?:"未记录"}\n"
internal fun canRecoverSession(session:JSONObject):Boolean=session.optString("inputContract")=="android-study-input-v1"&&session.optBoolean("requestIssued")&&session.optString("status") in setOf("pending","failed","cancelled","interrupted")
