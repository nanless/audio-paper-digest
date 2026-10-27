package com.nanless.paperdigest.zotero

import com.nanless.paperdigest.zotero.webdav.DavFiles
import java.io.Closeable
import java.io.File
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS

/** Native process capability. JSON and a later path observation cannot mint ownership. */
class ZoteroOwnedFileReceipt private constructor(
    private val file:File,private val createdIdentity:Any,private val parentIdentity:Any,
    private val observe:(File)->Any,
) {
    internal fun requireCurrent(){
        DavFiles.directory(file.parentFile)
        require(observe(file.parentFile)==parentIdentity&&observe(file)==createdIdentity){"下载临时原件或目录已被替换"}
    }
    internal fun deleteIfCurrent():Boolean {
        DavFiles.directory(file.parentFile)
        if(observe(file.parentFile)!=parentIdentity||!Files.exists(file.toPath(),NOFOLLOW_LINKS))return false
        if(observe(file)!=createdIdentity)return false
        Files.delete(file.toPath());return true
    }
    companion object {
        /** createdIdentity must come from the actual newly-created descriptor, not lstat(path). */
        internal fun native(file:File,createdIdentity:Any,parentIdentity:Any,observe:(File)->Any)=
            ZoteroOwnedFileReceipt(file,createdIdentity,parentIdentity,observe)
    }
}
interface ZoteroOwnedDownloadSink:Closeable {
    val channel:FileChannel
    val receipt:ZoteroOwnedFileReceipt
    fun force()
}
fun interface ZoteroOwnedDownloadFiles {
    fun create(file:File):ZoteroOwnedDownloadSink
}
