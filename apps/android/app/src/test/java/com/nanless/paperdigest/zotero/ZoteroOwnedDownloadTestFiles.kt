package com.nanless.paperdigest.zotero

import com.nanless.paperdigest.zotero.webdav.DavFiles
import java.io.File

/** Explicit host fixture only. It tests native receipt consumers with real files but does
 * NOT establish Android descriptor/fstat identity. Production has no JVM fallback. */
internal object ZoteroOwnedDownloadTestFiles:ZoteroOwnedDownloadFiles {
    private fun identity(file:File):Any=java.nio.file.Files.readAttributes(file.toPath(),java.nio.file.attribute.BasicFileAttributes::class.java,java.nio.file.LinkOption.NOFOLLOW_LINKS).let{
        require(!it.isSymbolicLink&&(it.isDirectory||it.isRegularFile));requireNotNull(it.fileKey())
    }
    fun receipt(file:File)=ZoteroOwnedFileReceipt.native(file,identity(file),identity(file.parentFile),::identity)
    override fun create(file:File):ZoteroOwnedDownloadSink {
        val channel=DavFiles.newChannel(file)
        try {
            val owned=receipt(file)
            return object:ZoteroOwnedDownloadSink {
                override val channel=channel
                override val receipt=owned
                override fun force(){channel.force(true)}
                override fun close(){channel.close()}
            }
        }catch(e:Throwable){channel.close();throw e}
    }
}
