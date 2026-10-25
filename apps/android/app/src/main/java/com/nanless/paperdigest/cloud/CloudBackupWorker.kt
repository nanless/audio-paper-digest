package com.nanless.paperdigest.cloud

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import kotlinx.coroutines.CancellationException
import java.util.concurrent.TimeUnit

/** Application.onCreate installs the same controller/workspace used by the foreground UI. */
object CloudWorkerRuntime {
    data class Provider(val service: (Context) -> CloudService, val runAutomatic: suspend (CloudService, String) -> Unit)
    @Volatile private var provider: Provider? = null
    @Volatile internal var executingAutomatic = false
    fun install(service: (Context) -> CloudService, runAutomatic: suspend (CloudService, String) -> Unit) { provider = Provider(service, runAutomatic) }
    internal fun current(): Provider? = provider
}
object CloudScheduler {
    private const val NAME = "paperdigest-cloud-backup"
    fun update(context: Context, destinationID: String, state: org.json.JSONObject) {
        val manager = WorkManager.getInstance(context)
        if (!state.optBoolean("automatic") || state.optBoolean("automaticPaused")) { if (!CloudWorkerRuntime.executingAutomatic) manager.cancelUniqueWork(NAME); return }
        val hours = state.optInt("intervalHours", 24); require(hours in 6..168)
        val constraints = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).setRequiresBatteryNotLow(true).setRequiresStorageNotLow(true).build()
        val request = PeriodicWorkRequestBuilder<CloudBackupWorker>(hours.toLong(), TimeUnit.HOURS)
            .setInitialDelay(hours.toLong(), TimeUnit.HOURS).setConstraints(constraints)
            .setInputData(workDataOf("destinationID" to destinationID))
            .addTag(NAME).build()
        manager.enqueueUniquePeriodicWork(NAME, ExistingPeriodicWorkPolicy.UPDATE, request)
    }
}
class CloudBackupWorker(context: Context, parameters: WorkerParameters) : CoroutineWorker(context, parameters) {
    override suspend fun doWork(): Result {
        val provider = CloudWorkerRuntime.current() ?: return Result.failure(workDataOf("error" to "application_not_initialized"))
        return try {
            val service = provider.service(applicationContext)
            val expectedID = inputData.getString("destinationID") ?: return Result.failure(workDataOf("error" to "target_changed"))
            if (service.targetID != expectedID) return Result.failure(workDataOf("error" to "target_changed"))
            val state = service.state()
            if (!state.optBoolean("automatic") || state.optBoolean("automaticPaused")) return Result.failure(workDataOf("error" to "automatic_paused"))
            if (state.optBoolean("busy")) return Result.retry()
            CloudWorkerRuntime.executingAutomatic = true
            try { provider.runAutomatic(service, expectedID) } finally {
                CloudWorkerRuntime.executingAutomatic = false
                val current = service.state()
                if (!current.optBoolean("automatic") || current.optBoolean("automaticPaused")) CloudScheduler.update(applicationContext, service.targetID, current)
            }
            Result.success()
        } catch (e: CancellationException) { throw e }
        catch (e: CloudFailure) { if (e.code == "busy" || e.code == "throttled" || e.code == "transport") Result.retry() else Result.failure(workDataOf("error" to e.code)) }
        catch (_: Exception) { Result.failure(workDataOf("error" to "backup_not_completed")) }
    }
}
