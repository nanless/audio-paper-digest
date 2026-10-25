package com.nanless.paperdigest.pdf

/** Opaque native instance; ID/name/SHA are display metadata, never an import qualification. */
class PdfImportSession internal constructor(
    val id:String,val displayName:String,val sha256:String,val passwordRequired:Boolean,
)

/** Native store checks instance identity again on finalize; copying its fields grants nothing. */
class PdfImportedOriginal internal constructor(
    val sessionID:String,val document:PdfDocumentRef,val encrypted:Boolean,val canExtract:Boolean,val canPrint:Boolean,
)

data class PdfDocumentAccess(val encrypted:Boolean,val canExtract:Boolean,val canPrint:Boolean)
/** Only a reverified, fully read original with a deterministic structural invalidity. */
class PdfInvalidDocumentException internal constructor(message:String,cause:Throwable?=null):java.io.IOException(message,cause)

class PdfPasswordRequiredException:IllegalArgumentException("此 PDF 需要本次解锁密码；原文件保持不变")
class PdfTextPermissionException:IllegalArgumentException("原 PDF 的权限不允许提取文字；仍可查看页面或分享原加密文件，未派发模型请求")

/** Caller owns and releases this one-page preview; original PDF bytes never become a bitmap export. */
data class PdfRenderedPage(val sha256:String,val page:Int,val bitmap:android.graphics.Bitmap,val widthPoints:Float,val heightPoints:Float)
