package com.nanless.paperdigest.model

import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files

/** 正常 JVM fixture 的显式接缝；不作为 ART 平台发布资格。 */
internal object HostCapturePublication : CapturePublication {
    override fun publishNew(target: File, bytes: ByteArray) {
        var ancestor: File? = target.absoluteFile.parentFile
        while (ancestor != null) { require(!Files.isSymbolicLink(ancestor.toPath())) { "Fixture refuses ancestor link" }; ancestor = ancestor.parentFile }
        val temporary = Files.createTempFile(target.parentFile.toPath(), ".host-capture-", ".tmp").toFile()
        try {
            FileOutputStream(temporary).use { it.write(bytes); it.fd.sync() }
            Files.createLink(target.toPath(), temporary.toPath())
        } finally { Files.deleteIfExists(temporary.toPath()) }
    }
}
