package com.nanless.paperdigest.pdf

import java.io.File
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.attribute.BasicFileAttributes

/** Process memory only, bounded and rooted in the actual workspace directory identity. */
internal object PdfSessionSecrets {
    internal data class Scope(val rootPath:String,val rootIdentity:String,val sha256:String)
    private val lock=Any()
    private val values=LinkedHashMap<Scope,CharArray>()
    fun scope(root:File,sha:String):Scope {
        require(Regex("[a-f0-9]{64}").matches(sha)) { "PDF 原件身份无效" }
        require(root.isDirectory && !Files.isSymbolicLink(root.toPath()) && root.absoluteFile==root.canonicalFile) { "PDF 研究目录已变化" }
        val attributes=Files.readAttributes(root.toPath(),BasicFileAttributes::class.java,LinkOption.NOFOLLOW_LINKS)
        val identity=requireNotNull(attributes.fileKey()) { "此存储无法核对本次解锁范围" }.toString()
        return Scope(root.absolutePath,identity,sha)
    }
    fun copy(root:File,sha:String):CharArray? {val key=scope(root,sha);return synchronized(lock){values[key]?.copyOf()}}
    fun put(root:File,sha:String,password:CharArray) {
        require(password.size<=4096) { "PDF 密码过长" }
        putPrepared(scope(root,sha),password)
    }
    fun putPrepared(scope:Scope,password:CharArray) {
        synchronized(lock){
            values.remove(scope)?.fill('\u0000')
            if(password.isNotEmpty())values[scope]=password.copyOf()
            while(values.size>8){val oldest=values.keys.first();values.remove(oldest)?.fill('\u0000')}
        }
    }
    fun clear(root:File)=synchronized(lock){
        val path=root.absolutePath
        val entries=values.keys.filter{it.rootPath==path}
        entries.forEach{values.remove(it)?.fill('\u0000')}
    }
}
