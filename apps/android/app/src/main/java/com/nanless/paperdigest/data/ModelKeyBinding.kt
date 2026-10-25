package com.nanless.paperdigest.data

import org.json.JSONObject
import java.io.File

/** A saved model key is usable only at the address for which the user saved it. */
class ModelKeyBinding(directory: File) {
    private val controlled = ControlledDeviceFiles(directory)
    @Synchronized fun bind(endpoint: String) {
        require(endpoint.isNotBlank())
        val file = controlled.file("model-key-binding.json")
        JsonFiles.write(file, JSONObject().put("contract", "paperdigest-model-key-binding-v1").put("endpoint", endpoint.trim().trimEnd('/')))
        controlled.file("model-key-binding.json", required = true)
    }
    @Synchronized fun clear() {
        val file = controlled.file("model-key-binding.json")
        if (file.exists()) require(file.delete()) { "旧模型连接绑定未能清除，已停止密钥更改" }
        controlled.file("model-key-binding.json")
    }
    @Synchronized fun requireEndpoint(endpoint: String) {
        val file = controlled.file("model-key-binding.json")
        if (!file.isFile) throw AppFailure("credentialsUnavailable", "请先为已保存的模型地址设置本机密钥")
        val bytes = JsonFiles.read(file, 64 * 1024L)
        controlled.file("model-key-binding.json", required = true)
        val stored = JSONObject(PublishedUtf8.decode(bytes))
        if (stored.optString("contract") != "paperdigest-model-key-binding-v1" || stored.getString("endpoint") != endpoint.trim().trimEnd('/')) {
            throw AppFailure("credentialsUnavailable", "模型地址已经变化，请为当前地址重新保存密钥；旧密钥不会发送到新地址。")
        }
    }
}
