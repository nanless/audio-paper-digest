package com.nanless.paperdigest.data

import com.nanless.paperdigest.cloud.BackupCodec
import org.json.JSONObject
import java.io.File

/** Old absolute paths are aliases only. Actual bytes must exist under this research root and match SHA. */
object StoragePaths {
    fun resolve(path: String, root: File, expectedSHA256: String, limit: Long = 256 * 1024 * 1024L): File {
        require(BackupCodec.validSHA(expectedSHA256)) { "缺少原文件内容指纹" }
        BackupCodec.checkedRoot(path)
        val current = root.canonicalFile
        BackupCodec.checkedDirectory(current)
        val roots = mutableListOf(current.absolutePath)
        val aliases = File(current, BackupCodec.ROOTS_FILE)
        if (aliases.exists()) {
            val o = JSONObject(JsonFiles.read(aliases, 8 * 1024 * 1024L).toString(Charsets.UTF_8))
            require(o.keys().asSequence().toSet() == setOf("contract", "roots") && o.getString("contract") == "paperdigest-storage-aliases-v1")
            roots += o.getJSONArray("roots").strings().onEach(BackupCodec::checkedRoot)
        }
        val relative = roots.distinct().mapNotNull { old -> if (path.startsWith("$old/")) path.removePrefix("$old/") else null }.distinct()
        require(relative.size == 1) { "原路径不在当前研究空间或已核验的恢复映射内" }
        val file = BackupCodec.checkedFile(current, relative.single())
        require(file.length() <= limit && BackupCodec.hash(file) == expectedSHA256) { "恢复的原文件与原内容指纹不符" }
        return file
    }
}
