package com.nanless.paperdigest.model

import android.system.OsConstants
import java.io.File
import java.io.IOException
import java.nio.file.FileAlreadyExistsException
import java.util.UUID

/** 完整响应的只创建发布；正常 JVM fixture 必须显式注入，生产始终使用原生发布。 */
internal fun interface CapturePublication { fun publishNew(target: File, bytes: ByteArray) }
internal object AndroidCapturePublication : CapturePublication {
    override fun publishNew(target: File, bytes: ByteArray) {
        val error = try { CapturePublicationNative.publishNoReplace(target.path, bytes, UUID.randomUUID().toString()) }
        catch (_: LinkageError) { throw IOException("此设备暂不能安全发布完整响应；原完整捕捉仍保留") }
        catch (_: SecurityException) { throw IOException("此设备暂不能安全发布完整响应；原完整捕捉仍保留") }
        when (error) {
            0 -> Unit
            OsConstants.EEXIST -> throw FileAlreadyExistsException("原响应材料已存在")
            else -> throw IOException("完整响应尚未安全发布；原完整捕捉仍保留")
        }
    }
}
