package com.nanless.paperdigest.protocols

import org.json.JSONObject

/** Recognizes exact formats; does not rewrite input, verify a source, or grant authority. */
object ClientProtocols {
    private val entries = JSONObject(GeneratedClientProtocols.json)
    val catalogSHA256: String get() = GeneratedClientProtocols.catalogSHA256
    private val reserved = setOf("contract", "schemaFingerprint", "version", "schemaVersion", "policyVersion", "__proto__")
    private fun entry(name: String): JSONObject = entries.getJSONObject(name)
    private fun choices(raw:Any?,name:String):List<JSONObject> {
        val values=entry(name).getJSONArray("formats")
        return (0 until values.length()).map{values.getJSONObject(it)}.filter{
            val tag=it.opt("tag")
            if(tag is Number && raw is Number)tag.toDouble().isFinite()&&raw.toDouble().isFinite()&&tag.toDouble()==raw.toDouble()&&tag.toLong()==raw.toLong()
            else tag==raw
        }
    }
    private fun select(raw:Any?,name:String,selectors:Array<out String?>):JSONObject {
        require(selectors.size<=1)
        return choices(raw,name).filter{selectors.isEmpty()||(it.opt("fp") as? String)==selectors[0]}.single()
    }
    fun contract(name: String): String { entry(name); return name }
    fun isContract(raw: Any?, name: String, variant: String? = null,vararg fingerprints:String?): Boolean {
        if(fingerprints.size>1)return false
        val found=choices(raw,name).filter{fingerprints.isEmpty()||(it.opt("fp") as? String)==fingerprints[0]}
        return found.isNotEmpty()&&(variant==null||found.all{it.getString("variant")==variant})
    }
    fun format(raw: Any?, name: String,vararg fingerprints:String?): String = select(raw,name,fingerprints).getString("variant")
    fun declaredSchema(raw:Any?,name:String,vararg fingerprints:String?):JSONObject = JSONObject(select(raw,name,fingerprints).getJSONObject("schema").toString())
    fun identityDomain(raw: String?, name: String,vararg fingerprints:String?): String { select(raw,name,fingerprints); return raw!! }
    fun historicalContract(name: String, variant: String): String {
        val values=entry(name).getJSONArray("formats")
        val found=(0 until values.length()).map{values.getJSONObject(it)}.filter{it.getBoolean("historical")&&it.getString("variant")==variant}.single()
        require(found.isNull("fp")&&choices(found.get("tag"),name).size==1)
        return found.getString("tag")
    }
    fun historicalHeader(name:String,variant:String,vararg fingerprints:String?):JSONObject {
        require(fingerprints.size<=1)
        val values=entry(name).getJSONArray("formats")
        val found=(0 until values.length()).map{values.getJSONObject(it)}.filter{it.getBoolean("historical")&&it.getString("variant")==variant&&(fingerprints.isEmpty()||(it.opt("fp") as? String)==fingerprints[0])}.single()
        return JSONObject(found.getJSONObject("header").toString())
    }
    fun schemaFingerprint(name: String): String = entry(name).getString("schemaFingerprint")
    fun recordHeader(raw: Any?, name: String,vararg fingerprints:String?): JSONObject {
        val header=if(raw==name&&fingerprints.isEmpty())entry(name).getJSONObject("headers").getJSONObject(name) else select(raw,name,fingerprints).getJSONObject("header")
        return JSONObject(header.toString())
    }
    fun record(name: String, fields: JSONObject = JSONObject()): JSONObject {
        require(fields.keys().asSequence().none { it in reserved }) { "资料字段不能覆盖协议头" }
        return recordHeader(contract(name), name).also { output -> fields.keys().forEach { output.put(it, fields.get(it)) } }
    }
    fun hasValidHeader(record: JSONObject, name: String, field: String = "contract"): Boolean = runCatching {
        if(!record.has(field))return false
        val expected = recordHeader(record.get(field), name,record.opt("schemaFingerprint") as? String)
        (reserved + expected.keys().asSequence().toSet()).all { key ->
            if (expected.has(key)) {
                val value = expected.get(key); val actual = record.opt(key)
                when (value) {
                    is String -> actual is String && value == actual
                    is Number -> actual is Number && value.toDouble() == actual.toDouble()
                    is Boolean -> actual is Boolean && value == actual
                    else -> false
                }
            } else !record.has(key)
        }
    }.getOrDefault(false)
    fun isCurrentHeader(record:JSONObject,name:String,field:String="contract")=hasValidHeader(record,name,field)&&record.opt(field)==name&&record.opt("schemaFingerprint")==schemaFingerprint(name)
    fun recordKeys(raw: Any?, name: String, fields: Set<String>,vararg fingerprints:String?): Set<String> =
        fields + recordHeader(raw, name,*fingerprints).keys().asSequence().toSet()
}
