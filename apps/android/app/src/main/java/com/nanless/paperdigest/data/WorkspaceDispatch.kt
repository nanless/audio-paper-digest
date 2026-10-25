package com.nanless.paperdigest.data

import org.json.JSONObject
import java.io.File
import java.util.UUID

/** Device-local dispatch capability, intentionally outside portable research backups. */
class WorkspaceDispatch(directory: File) {
    private val file = File(directory.canonicalFile, "dispatch.json")
    @Volatile var epoch: String = if (file.exists()) JSONObject(JsonFiles.read(file, 4096).toString(Charsets.UTF_8)).getString("epoch").also { UUID.fromString(it) }
        else UUID.randomUUID().toString().also { JsonFiles.write(file, JSONObject().put("contract", "paperdigest-device-dispatch-v1").put("epoch", it)) }
        private set
    fun rotate() { val fresh = UUID.randomUUID().toString(); JsonFiles.write(file, JSONObject().put("contract", "paperdigest-device-dispatch-v1").put("epoch", fresh)); epoch = fresh }
    fun requireCurrent(expected: String) { require(expected == epoch) { "此任务属于恢复前的研究空间，原调度已经退役；不会自动发出新的请求。" } }
}
