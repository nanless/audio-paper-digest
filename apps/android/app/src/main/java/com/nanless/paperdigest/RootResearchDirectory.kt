package com.nanless.paperdigest

import com.nanless.paperdigest.data.AppFailure
import java.io.File
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS

/** Normalize only the OS-provided base, never erase a controlled-child link before validation. */
internal object RootResearchDirectory {
    fun resolve(nativeNoBackupDirectory: File): File {
        val base = nativeNoBackupDirectory.canonicalFile
        var current = base.toPath().root ?: throw AppFailure("storage", "系统资料目录不是绝对路径")
        checkDirectory(current.toFile())
        for (component in base.toPath()) {
            current = current.resolve(component)
            checkDirectory(current.toFile())
        }
        val research = File(base, "PaperDigest")
        if (!Files.exists(research.toPath(), NOFOLLOW_LINKS)) {
            // One fixed child only. Recheck after a concurrent create; never mkdirs through an unknown child.
            if (!research.mkdir() && !Files.exists(research.toPath(), NOFOLLOW_LINKS)) {
                throw AppFailure("storage", "无法创建本机研究目录，未读取或改写原资料")
            }
        }
        checkDirectory(research)
        return research
    }
    /** Keep controlled children uncanonicalized so StorageCapacity can reject ancestor links lazily. */
    fun capacityPaths(nativeNoBackupDirectory: File): Triple<File, File, File> {
        val base = nativeNoBackupDirectory.canonicalFile
        return Triple(File(base, "PaperDigestTransfers/Exports"), File(base, "PaperDigestCloud"), File(base, "PaperDigestDevice"))
    }
    private fun checkDirectory(directory: File) {
        if (Files.isSymbolicLink(directory.toPath()) || !Files.isDirectory(directory.toPath(), NOFOLLOW_LINKS)) {
            throw AppFailure("storage", "研究目录或父目录不是普通目录，未沿链接读取或改写资料")
        }
    }
}
