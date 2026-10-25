package com.nanless.paperdigest.data

import org.json.JSONObject
import java.io.File
import java.util.UUID

/** Device-local dispatch capability, intentionally outside portable research backups. */
class WorkspaceDispatch(directory: File) {
    private val controlled = ControlledDeviceFiles(directory)
    @Volatile var epoch: String = loadOrCreate()
        private set
    private fun loadOrCreate(): String {
        val file = controlled.file("dispatch.json")
        return if (file.exists()) {
            val bytes = JsonFiles.read(file, 4096)
            controlled.file("dispatch.json", required = true)
            JSONObject(PublishedUtf8.decode(bytes)).getString("epoch").also { UUID.fromString(it) }
        } else UUID.randomUUID().toString().also {
            JsonFiles.write(file, JSONObject().put("contract", "paperdigest-device-dispatch-v1").put("epoch", it))
            controlled.file("dispatch.json", required = true)
        }
    }
    @Synchronized fun rotate() {
        val file = controlled.file("dispatch.json", required = true)
        val fresh = UUID.randomUUID().toString()
        JsonFiles.write(file, JSONObject().put("contract", "paperdigest-device-dispatch-v1").put("epoch", fresh))
        controlled.file("dispatch.json", required = true)
        epoch = fresh
    }
    /** Pure memory check on hot streaming paths; all actual record I/O is guarded above. */
    fun requireCurrent(expected: String) {
        require(expected == epoch) { "此任务属于恢复前的研究空间，原调度已经退役；不会自动发出新的请求。" }
    }
}
