package com.nanless.paperdigest

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.work.CoroutineWorker
import androidx.work.ForegroundInfo
import androidx.work.WorkManager
import androidx.work.WorkerParameters

/** Android can interrupt work; an already-issued paid request is never automatically reissued. */
class StudyWorker(context: Context, parameters: WorkerParameters): CoroutineWorker(context, parameters) {
    override suspend fun doWork(): Result {
        val sessionID = inputData.getString("sessionID") ?: return Result.failure()
        val controller = (applicationContext as PaperDigestApplication).controller
        return try {
            setForeground(notification())
            controller.performStudy(sessionID, inputData.getString("workspaceEpoch") ?: return Result.failure())
            Result.success()
        } catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled }
        catch (_: Exception) { Result.failure() }
    }
    private fun notification(): ForegroundInfo {
        val manager = applicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.createNotificationChannel(NotificationChannel("research", "论文研究任务", NotificationManager.IMPORTANCE_LOW))
        val cancel = WorkManager.getInstance(applicationContext).createCancelPendingIntent(id)
        val notification = NotificationCompat.Builder(applicationContext, "research").setSmallIcon(android.R.drawable.ic_menu_info_details)
            .setContentTitle("论文速递工作台正在分析原文").setContentText("原始材料和用量会保存在本机；可停止等待")
            .setOngoing(true).addAction(android.R.drawable.ic_menu_close_clear_cancel, "停止", cancel).build()
        return if (Build.VERSION.SDK_INT >= 29) ForegroundInfo(4317, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC) else ForegroundInfo(4317, notification)
    }
}
