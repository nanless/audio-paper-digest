package com.nanless.paperdigest

import org.json.JSONArray
import org.json.JSONObject

/** Native-only per-selection facts. The selected content URIs and passwords never enter these records. */
internal class PdfImportBatchProgress(total: Int) {
    private data class Fact(val paperID: String, val sha256: String, val pageCount: Int)
    private data class Item(val index: Int, val status: String = "notDispatched", val jobID: String? = null, val fact: Fact? = null)
    private val items = MutableList(total.also { require(it > 0) }) { Item(it) }

    fun begin(index: Int, jobID: String) {
        require(items[index].status == "notDispatched" && jobID.isNotBlank())
        items[index] = Item(index, "running", jobID)
    }
    fun completed(index: Int, actual: JSONObject) {
        val sha = actual.getString("sha256")
        require(Regex("[a-f0-9]{64}").matches(sha))
        val fact = Fact(actual.getString("paperID"), sha, actual.getInt("pageCount"))
        require(fact.paperID == "local:$sha" && fact.pageCount > 0)
        val previous = items[index]
        require(previous.status == "running" || previous.status == "completed" && previous.fact == fact)
        items[index] = previous.copy(status = "completed", fact = fact)
    }
    fun failed(index: Int) { terminal(index, "failed") }
    fun cancelled(index: Int) { terminal(index, "cancelled") }
    private fun terminal(index: Int, status: String) {
        val previous = items[index]
        require(previous.status == "running") { "已经完成的原件不能被改记为未导入" }
        items[index] = previous.copy(status = status)
    }
    fun status(index: Int) = items[index].status
    fun hasRemaining() = items.any { it.status == "notDispatched" || it.status == "running" }
    fun finalStatus(stopped: Boolean): String = when {
        stopped && hasRemaining() || items.any { it.status == "cancelled" } -> "cancelled"
        items.any { it.status == "failed" } -> "failed"
        items.all { it.status == "completed" } -> "completed"
        else -> "failed"
    }
    fun snapshot(status: String): JSONObject {
        val value = JSONObject().put("status", status).put("total", items.size)
        for (kind in listOf("completed", "failed", "cancelled", "notDispatched", "running")) {
            value.put(kind, items.count { it.status == kind })
        }
        return value.put("items", JSONArray(items.map { row ->
            JSONObject().put("index", row.index).put("status", row.status).also { item ->
                row.jobID?.let { item.put("jobID", it) }
                row.fact?.let { fact -> item.put("paperID", fact.paperID).put("sha256", fact.sha256).put("pageCount", fact.pageCount) }
            }
        }))
    }
    fun message(): String {
        val n = snapshot("running")
        return "所选 ${items.size} 份 PDF：已接纳 ${n.getInt("completed")}，未完成 ${n.getInt("failed")}，已停止 ${n.getInt("cancelled")}，准备中 ${n.getInt("running")}，未开始 ${n.getInt("notDispatched")}。"
    }
}
