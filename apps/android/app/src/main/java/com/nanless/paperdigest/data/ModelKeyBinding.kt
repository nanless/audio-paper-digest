package com.nanless.paperdigest.data

import org.json.JSONObject
import java.io.File

/** A saved model key is usable only at the address for which the user saved it. */
class ModelKeyBinding(directory: File) {
    private val file = File(directory.canonicalFile, "model-key-binding.json")
    fun bind(endpoint: String) { require(endpoint.isNotBlank()); JsonFiles.write(file, JSONObject().put("contract", "paperdigest-model-key-binding-v1").put("endpoint", endpoint.trim().trimEnd('/'))) }
    fun clear() { if (file.exists()) require(file.delete()) { "旧模型连接绑定未能清除，已停止密钥更改" } }
    fun requireEndpoint(endpoint: String) {
        if (!file.isFile) throw AppFailure("credentialsUnavailable", "请先为已保存的模型地址设置本机密钥")
        val stored = JSONObject(JsonFiles.read(file, 64 * 1024L).toString(Charsets.UTF_8))
        if (stored.optString("contract") != "paperdigest-model-key-binding-v1" || stored.getString("endpoint") != endpoint.trim().trimEnd('/')) throw AppFailure("credentialsUnavailable", "模型地址已经变化，请为当前地址重新保存密钥；旧密钥不会发送到新地址。")
    }
}
