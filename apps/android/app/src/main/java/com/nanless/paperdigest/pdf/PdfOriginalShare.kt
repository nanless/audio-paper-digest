package com.nanless.paperdigest.pdf

import android.app.Activity
import android.content.Context
import android.content.ClipData
import android.content.Intent
import androidx.core.content.FileProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

object PdfOriginalShare {
    suspend fun readIntent(context:Context,snapshot:PdfOriginalSnapshot):Intent {
        snapshot.validate()
        return withContext(Dispatchers.Main.immediate) {
            snapshot.requireActiveOwner()
            val name=snapshot.document.displayName.replace(Regex("[\\p{Cntrl}/\\\\]"),"_").take(160).ifBlank{"论文原文.pdf"}
            val uri=FileProvider.getUriForFile(context,context.packageName+".pdf-originals",snapshot.file)
            Intent(Intent.ACTION_SEND).apply{type="application/pdf";putExtra(Intent.EXTRA_STREAM,uri);putExtra(Intent.EXTRA_TITLE,name);clipData=ClipData.newRawUri(name,uri);addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)}
        }
    }
    suspend fun openChooser(activity:Activity,snapshot:PdfOriginalSnapshot):String {
        val send=readIntent(activity,snapshot)
        return withContext(Dispatchers.Main.immediate) {
            require(!activity.isFinishing&&!activity.isDestroyed){"当前窗口已关闭，未打开旧原件分享"}
            snapshot.requireActiveOwner()
            activity.startActivity(Intent.createChooser(send,"分享原始 PDF").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
            snapshot.markHandedOff()
            "已打开系统分享；是否保存由接收应用决定，尚未核验存档。"
        }
    }
}
