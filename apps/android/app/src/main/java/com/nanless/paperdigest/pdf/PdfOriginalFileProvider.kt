package com.nanless.paperdigest.pdf

import android.content.ContentValues
import android.net.Uri
import android.os.ParcelFileDescriptor
import androidx.core.content.FileProvider
import com.nanless.paperdigest.R
import java.io.File
import java.io.FileNotFoundException
import java.nio.file.Files
import java.util.UUID

/** Separate from general exports: one immutable PDF URI, no directory or write grants. */
class PdfOriginalFileProvider:FileProvider(R.xml.pdf_share_paths) {
    private fun checked(uri:Uri):File {
        val ctx=requireNotNull(context);val parts=uri.pathSegments
        if(uri.scheme!="content"||uri.authority!=ctx.packageName+".pdf-originals"||uri.query!=null||uri.fragment!=null||parts.size!=3||parts[0]!="originals"||parts[2]!="original.pdf")throw FileNotFoundException("PDF 分享地址无效")
        val token=runCatching{UUID.fromString(parts[1]).toString()}.getOrNull();if(token!=parts[1])throw FileNotFoundException("PDF 分享地址无效")
        val root=File(ctx.cacheDir.canonicalFile,"PdfOutbound");val folder=File(root,token);val file=File(folder,"original.pdf")
        if(Files.isSymbolicLink(root.toPath())||Files.isSymbolicLink(folder.toPath())||Files.isSymbolicLink(file.toPath())||file.absoluteFile!=file.canonicalFile||!file.isFile||file.length()<=0||file.length()>200L*1024*1024)throw FileNotFoundException("原始 PDF 分享副本不存在")
        return file
    }
    override fun openFile(uri:Uri,mode:String):ParcelFileDescriptor {
        if(mode!="r")throw SecurityException("原始 PDF 分享仅允许读取")
        return ParcelFileDescriptor.open(checked(uri),ParcelFileDescriptor.MODE_READ_ONLY)
    }
    override fun query(uri:Uri,projection:Array<out String>?,selection:String?,selectionArgs:Array<out String>?,sortOrder:String?):android.database.Cursor {checked(uri);return super.query(uri,projection,selection,selectionArgs,sortOrder)}
    override fun getType(uri:Uri):String {checked(uri);return "application/pdf"}
    override fun delete(uri:Uri,selection:String?,selectionArgs:Array<out String>?):Int=throw SecurityException("分享副本不能由接收方删除")
    override fun insert(uri:Uri,values:ContentValues?):Uri=throw SecurityException("分享原件仅允许读取")
    override fun update(uri:Uri,values:ContentValues?,selection:String?,selectionArgs:Array<out String>?):Int=throw SecurityException("分享原件仅允许读取")
}
