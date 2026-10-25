package com.nanless.paperdigest

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.work.*

/** Manual uploads retain their immutable snapshot and checkpoint if the OS stops this worker. */
class CloudTransferWorker(context: Context, parameters: WorkerParameters): CoroutineWorker(context, parameters) {
    override suspend fun doWork(): Result {
        val controller = (applicationContext as PaperDigestApplication).controller
        val expectedDestination = inputData.getString("destinationID") ?: return Result.failure()
        return try { setForeground(notification()); controller.performCloudUpload(id.toString(), inputData.getString("workspaceEpoch") ?: return Result.failure(), expectedDestination); Result.success() }
        catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled }
        catch (_: Exception) { Result.failure() }
    }
    private fun notification(): ForegroundInfo {
        (applicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).createNotificationChannel(NotificationChannel("cloud", "研究资料备份", NotificationManager.IMPORTANCE_LOW))
        val notification = NotificationCompat.Builder(applicationContext, "cloud").setSmallIcon(android.R.drawable.ic_menu_upload)
            .setContentTitle("论文速递正在备份研究资料").setContentText("按原快照上传并逐块回读；停止后可从检查点续传")
            .setOngoing(true).addAction(android.R.drawable.ic_menu_close_clear_cancel, "停止", WorkManager.getInstance(applicationContext).createCancelPendingIntent(id)).build()
        return if (Build.VERSION.SDK_INT >= 29) ForegroundInfo(4318, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC) else ForegroundInfo(4318, notification)
    }
}
