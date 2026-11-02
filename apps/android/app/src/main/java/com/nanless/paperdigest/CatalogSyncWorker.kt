package com.nanless.paperdigest

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters

/** Fetches existing published results only; never starts the server's analysis pipeline. */
class CatalogSyncWorker(context: Context, parameters: WorkerParameters): CoroutineWorker(context, parameters) {
    override suspend fun doWork(): Result = try {
        val controller = (applicationContext as PaperDigestApplication).awaitController()
        controller.performAutomaticCatalogSync()
        Result.success()
    } catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled }
    catch (_: Exception) { Result.failure() }
}
