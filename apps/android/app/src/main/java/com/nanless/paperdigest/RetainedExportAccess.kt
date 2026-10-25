package com.nanless.paperdigest

import com.nanless.paperdigest.cloud.BackupCodec
import com.nanless.paperdigest.data.*
import org.json.JSONObject
import java.io.File
import java.util.UUID

/** Root maintenance owns every call. Presentation IDs never construct backend capabilities. */
internal class RetainedExportAccess(
    private val pending: () -> PendingExportStore,
    private val service: () -> RetainedExportService,
    private val controlRoot: File,
    private val currentEpoch: () -> String,
) {
    private data class Confirmation(val operationID: String, val revision: String, val epoch: String)
    internal data class Lease(val snapshot: RetainedSnapshot, val delivery: RetainedDelivery,
        val epoch: String, val writerJobID: String? = null)
    private val confirmations = HashMap<String, Confirmation>()
    private val deliveries = HashMap<String, Lease>()

    fun confirmation(operationID: String): JSONObject {
        val row = pending().get(operationID)
        require(row.sourceIdentity.optString("format") == "backup") { "这里只能保留原完整研究快照的准备材料" }
        val revision = pending().preparationRevision(operationID)
        val id = UUID.randomUUID().toString()
        confirmations.clear()
        confirmations[id] = Confirmation(operationID, revision, currentEpoch())
        return JSONObject().put("confirmationID", id).put("operationID", operationID)
            .put("message", "原准备已停止。保留材料并结束本次准备，不删除原快照、冲突文件或旧历史；不完整或损坏材料可能无法另存。")
    }
    fun retain(id: String): PendingExportStore.PendingExport {
        val original = confirmations.remove(id) ?: error("保留确认已结束，请重新读取原操作")
        require(original.epoch == currentEpoch()) { "研究空间已变化，旧保留确认没有操作新空间的权限" }
        return pending().retainPreparation(original.operationID, original.revision)
    }
    fun discardConfirmation(id: String) { confirmations.remove(id) }

    fun prepare(operationID: String, check: () -> Unit): JSONObject {
        check()
        val epoch = currentEpoch()
        val snapshot = service().prepareSnapshot(operationID, check)
        check(); require(epoch == currentEpoch())
        val delivery = service().beginDelivery(snapshot, check)
        deliveries[delivery.attemptID] = Lease(snapshot, delivery, epoch)
        return JSONObject().put("exportRoute", "retained").put("preparation", "retained").put("delivery", "choosing")
            .put("operationID", snapshot.operationID).put("attemptID", delivery.attemptID)
            .put("documentID", snapshot.documentID).put("mime", snapshot.mime).put("suggestedName", snapshot.name)
            .put("bytes", snapshot.bytes).put("sha256", snapshot.sha256)
            .put("message", "原完整快照已核验，尚未写到所选位置；未重新采集当前资料。")
    }
    fun lease(operationID: String, attemptID: String): Lease {
        val original = deliveries[attemptID] ?: error("原保留快照保存许可已结束，请明确重新核验")
        require(original.delivery.operationID == operationID && original.epoch == currentEpoch()) {
            "旧保存回调与原操作或研究空间不符，未写出另一份材料"
        }
        return original
    }
    fun claimWriter(operationID: String, attemptID: String, jobID: String): Lease {
        val original = lease(operationID, attemptID)
        require(original.writerJobID == null) { "本次原快照已开始保存，请等待原任务结束" }
        return original.copy(writerJobID = jobID).also { deliveries[attemptID] = it }
    }
    fun cancelChooser(operationID: String, attemptID: String): JSONObject {
        val original = lease(operationID, attemptID)
        require(original.writerJobID == null) { "正在写入，请到原任务请求停止并等待实际关闭" }
        return service().chooserCancelled(original.delivery).also { deliveries.remove(attemptID) }
    }
    fun release(attemptID: String) { deliveries.remove(attemptID) }
    fun hasDelivery(): Boolean = deliveries.isNotEmpty()
    fun writerFor(operationID: String): List<String> = deliveries.values.filter { it.delivery.operationID == operationID }.mapNotNull { it.writerJobID }
    fun retireAll() {
        var failed: Throwable? = null
        try {
            for (lease in deliveries.values) {
                try {
                    require(lease.writerJobID == null) { "请先等待原快照写入任务实际关闭，再恢复资料" }
                    service().chooserCancelled(lease.delivery)
                } catch (failure: Throwable) { if (failed == null) failed = failure }
            }
        } finally { confirmations.clear(); deliveries.clear() }
        if (failed != null) throw IllegalStateException("旧保留快照保存窗口未能完整退休，请先核对原记录；未恢复研究资料", failed)
    }

    /** Native control tasks describe this later operation, never the original captured job or paid history. */
    fun writeJob(operationID: String, job: JSONObject) {
        val row = pending().get(operationID)
        require(row.preparation == "retained")
        val id = job.getString("id"); require(UUID.fromString(id).toString() == id)
        require(job.getString("kind") in KINDS && job.getString("paperID").isEmpty())
        require(job.getString("status") in STATES)
        val value = job.copy().put("localRetainedExport", true).put("nativeOperationID", operationID)
        val wrapper = JSONObject().put("contract", JOB).put("operationID", operationID)
            .put("documentID", row.documentID).put("job", value)
        JsonFiles.write(jobFile(operationID, id), wrapper)
    }
    fun readJobs(row: PendingExportStore.PendingExport, activeIDs: Set<String>): List<JSONObject> {
        val directory = File(controlRoot, row.operationID)
        BackupCodec.checkedDirectory(directory)
        val files = (directory.listFiles() ?: error("无法完整读取保留快照任务记录"))
            .filter { it.name.startsWith("retained-native-job-") }
        require(row.preparation == "retained" || files.isEmpty()) { "普通准备记录下出现未识别的保留任务" }
        return files.map { file ->
            require(file.name.matches(Regex("retained-native-job-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\\.json")))
            val raw = JSONObject(PublishedUtf8.decode(JsonFiles.read(BackupCodec.checkedFile(directory, file.name), 65536)))
            require(raw.keys().asSequence().toSet() == setOf("contract", "operationID", "documentID", "job"))
            require(raw.getString("contract") == JOB && raw.getString("operationID") == row.operationID && raw.getString("documentID") == row.documentID)
            val job = raw.getJSONObject("job"); val id = job.getString("id")
            require(file == jobFile(row.operationID, id) && job.getString("kind") in KINDS && job.getString("status") in STATES)
            require(job.opt("localRetainedExport") == true && job.getString("nativeOperationID") == row.operationID && job.getString("paperID").isEmpty())
            if (job.getString("status") == "running" && id !in activeIDs) {
                job.put("status", "interrupted").put("endedAt", now())
                    .put("message", "原保留快照任务已中断；原快照、历史与外部可能已写出的文件保留。")
                writeJob(row.operationID, job)
            }
            job
        }
    }
    private fun jobFile(operationID: String, id: String): File {
        require(UUID.fromString(operationID).toString() == operationID && UUID.fromString(id).toString() == id)
        val directory = File(controlRoot, operationID); BackupCodec.checkedDirectory(directory)
        return File(directory, "retained-native-job-$id.json")
    }
    companion object {
        private const val JOB = "paperdigest-native-retained-export-job-v1"
        private val KINDS = setOf("export.retained.prepare", "export.retained.save")
        private val STATES = setOf("running", "completed", "failed", "cancelled", "interrupted")
    }
}
