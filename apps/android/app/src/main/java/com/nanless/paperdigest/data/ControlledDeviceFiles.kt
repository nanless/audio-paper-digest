package com.nanless.paperdigest.data

import java.io.File
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.attribute.BasicFileAttributes

/** Caller normalizes the OS base first. This guard never canonicalizes a controlled child. */
internal class ControlledDeviceFiles(directory: File) {
    private val root = directory.absoluteFile
    private val identity: Any
    init {
        require(root.toPath().normalize().toFile() == root) { "本机控制目录路径无效" }
        checkDirectories(create = true)
        identity = attributes(root).fileKey() ?: throw AppFailure("storage", "无法确认本机控制目录身份")
    }
    fun file(name: String, required: Boolean = false): File {
        require(name in setOf("model-key-binding.json", "dispatch.json"))
        checkDirectories(create = false)
        if (attributes(root).fileKey() != identity) throw AppFailure("storage", "本机控制目录已被替换，未沿另一目录读写")
        val result = File(root, name)
        if (Files.exists(result.toPath(), NOFOLLOW_LINKS)) {
            if (Files.isSymbolicLink(result.toPath()) || !Files.isRegularFile(result.toPath(), NOFOLLOW_LINKS)) {
                throw AppFailure("storage", "本机控制记录不是普通文件，未沿链接读取或改写")
            }
        } else if (required) throw AppFailure("storage", "本机控制记录缺失，未认领另一份调度许可")
        return result
    }
    private fun checkDirectories(create: Boolean) {
        var current = root.toPath().root ?: throw AppFailure("storage", "本机控制目录不是绝对路径")
        for (component in root.toPath()) {
            current = current.resolve(component)
            if (!Files.exists(current, NOFOLLOW_LINKS) && create) {
                try { Files.createDirectory(current) }
                catch (existing: java.nio.file.FileAlreadyExistsException) { /* Recheck the actual object below. */ }
            }
            if (Files.isSymbolicLink(current) || !Files.isDirectory(current, NOFOLLOW_LINKS)) {
                throw AppFailure("storage", "本机控制目录或父目录不是普通目录，未沿链接读写")
            }
        }
    }
    private fun attributes(file: File) = Files.readAttributes(file.toPath(), BasicFileAttributes::class.java, NOFOLLOW_LINKS)
}
