package com.nanless.paperdigest.zotero

import android.os.Process
import android.system.Os
import android.system.OsConstants
import android.system.StructStat
import com.nanless.paperdigest.zotero.webdav.DavFiles
import java.io.File
import java.io.FileOutputStream

/** API21+ public POSIX API; the created descriptor is the only source of file ownership. */
internal object AndroidZoteroOwnedDownloadFiles:ZoteroOwnedDownloadFiles {
    private data class Node(val dev:Long,val ino:Long,val uid:Int,val mode:Int,val links:Long)
    private fun node(s:StructStat)=Node(s.st_dev,s.st_ino,s.st_uid,s.st_mode,s.st_nlink)
    private fun observe(f:File)=node(Os.lstat(f.absolutePath))
    override fun create(file:File):ZoteroOwnedDownloadSink {
        DavFiles.directory(file.parentFile)
        val parent=Os.lstat(file.parentFile.absolutePath)
        require(OsConstants.S_ISDIR(parent.st_mode)&&parent.st_uid==Process.myUid()){"临时目录身份不符"}
        val fd=Os.open(file.absolutePath,OsConstants.O_WRONLY or OsConstants.O_CREAT or OsConstants.O_EXCL or OsConstants.O_NOFOLLOW or OsConstants.O_CLOEXEC,384)
        var stream:FileOutputStream?=null;var receipt:ZoteroOwnedFileReceipt?=null
        try {
            val created=Os.fstat(fd)
            require(OsConstants.S_ISREG(created.st_mode)&&created.st_nlink==1L&&created.st_uid==Process.myUid()){"新下载描述符身份不符"}
            val createdReceipt=ZoteroOwnedFileReceipt.native(file,node(created),node(parent),::observe);receipt=createdReceipt
            createdReceipt.requireCurrent()
            val output=FileOutputStream(fd);stream=output
            return object:ZoteroOwnedDownloadSink {
                override val channel=output.channel
                override val receipt=createdReceipt
                override fun force(){output.flush();Os.fsync(fd)}
                override fun close(){output.close()}
            }
        }catch(e:Throwable){
            try{if(stream!=null)stream.close()else Os.close(fd)}catch(close:Throwable){e.addSuppressed(close)}
            try{receipt?.deleteIfCurrent()}catch(cleanup:Throwable){e.addSuppressed(cleanup)}
            throw e
        }
    }
}
