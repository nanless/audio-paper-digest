package com.nanless.paperdigest.cloud

import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** Native-only lifetime context. Restoring a workspace changes epoch; saving a target changes destinationID. */
internal data class CloudSelectionContext(val destinationID: String, val workspaceEpoch: String)

/** The UI receives opaque handles, never authority to nominate a reference or expected manifest. */
internal class CloudRestoreSelections(private val service: CloudService, private val current: () -> CloudSelectionContext) {
    private data class Selection(val context: CloudSelectionContext, val generation: Long, val identity: CloudSnapshotIdentity)
    private val monitor = Any()
    private var observedContext: CloudSelectionContext? = null
    private var contextToken = ""
    private var generation = 0L
    private val selections = HashMap<String, Selection>()

    private fun contextLocked(): CloudSelectionContext {
        val actual = current()
        if (actual != observedContext) {
            observedContext = actual; contextToken = UUID.randomUUID().toString(); generation++; selections.clear()
        }
        return actual
    }
    fun contextToken(): String = synchronized(monitor) { contextLocked(); contextToken }
    private fun requireCurrent(selection: Selection) = synchronized(monitor) {
        if (contextLocked() != selection.context || generation != selection.generation) throw CloudFailure("selectionExpired")
    }
    private fun selected(id: String): Selection = synchronized(monitor) {
        contextLocked()
        selections[id]?.also(::requireCurrent) ?: throw CloudFailure("selectionExpired")
    }
    fun requireSelection(id: String) { selected(id) }

    suspend fun list(month: String): JSONObject {
        val started = synchronized(monitor) { val actual = contextLocked(); generation++; selections.clear(); actual to generation }
        val rows = service.listBound(month, started.first.destinationID)
        return synchronized(monitor) {
            if (contextLocked() != started.first || generation != started.second) throw CloudFailure("selectionExpired")
            val result = JSONArray()
            for (identity in rows) {
                val id = UUID.randomUUID().toString()
                selections[id] = Selection(started.first, started.second, identity)
                result.put(identity.info().put("selectionID", id).put("month", identity.reference.month).put("id", identity.reference.id))
            }
            JSONObject().put("selectionContext", contextToken).put("month", month).put("snapshots", result)
        }
    }
    suspend fun prepare(id: String, check: () -> Unit = {}): CloudService.PreparedRestore {
        val selected = selected(id)
        // This handle is single-use. Its captured generation remains checkable while downloading.
        synchronized(monitor) { if (selections.remove(id) !== selected) throw CloudFailure("selectionExpired") }
        val prepared = service.prepareRestoreBound(selected.identity, selected.context.destinationID) { requireCurrent(selected); check() }
        try { requireCurrent(selected); check(); return prepared }
        catch (failure: Throwable) { prepared.staged.directory.deleteRecursively(); throw failure }
    }
}
