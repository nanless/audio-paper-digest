package com.nanless.paperdigest.pdf

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import java.io.File
import java.io.InputStream
import java.nio.file.Files
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

/** Private, exact original bytes for one explicit output operation; never a research-space authority. */
class PdfOriginalSnapshot private constructor(
    val ownerID:String,val document:PdfDocumentRef,internal val file:File,
    private val repository:PdfRepository,private val requireCurrent:()->Unit,private val originalFile:File
) {
    private val discarded=AtomicBoolean()
    @Volatile private var handedOff=false
    /** Only the real system handoff path marks this; UI cancellation cannot retract it. */
    internal fun markHandedOff()=synchronized(lifetimeLock){check(!discarded.get() && file.isFile){"原文输出副本已关闭"};handedOff=true}
    val hasBeenHandedOff:Boolean get()=handedOff
    fun discardIfUnhanded():Boolean=synchronized(lifetimeLock){if(handedOff)false else{discard();true}}
    internal fun copySessionPassword():CharArray?{requireActiveOwner();return repository.copySessionPassword(document)}
    internal fun requireActiveOwner(){check(!discarded.get()){ "原文输出副本已关闭" };requireCurrent()}
    internal fun pin()=synchronized(lifetimeLock){requireActiveOwner();check(file.parentFile!!.name !in purging){"输出副本正在到期清理，请重新准备"};require(file.isFile&&!Files.isSymbolicLink(file.toPath())&&file.absoluteFile==file.canonicalFile){"输出副本已到期，请重新准备"};check(active.add(file.parentFile!!.name)){"此原文输出副本已有进行中的打印，请重新准备"}}
    suspend fun validate()=withContext(Dispatchers.IO) {
        currentCoroutineContext().ensureActive();requireCurrent();repository.verify(document)
        require(!Files.isSymbolicLink(file.toPath()) && file.isFile && file.absoluteFile==file.canonicalFile && digest(file)==document.sha256) { "待输出的 PDF 原件已变化" }
        requireCurrent();currentCoroutineContext().ensureActive()
    }
    internal fun checkBytes(check:()->Unit) {
        check();requireCurrent()
        require(!Files.isSymbolicLink(originalFile.toPath()) && originalFile.absoluteFile==originalFile.canonicalFile && digest(originalFile,check)==document.sha256) { "打开的 PDF 原件已变化" }
        require(!Files.isSymbolicLink(file.toPath())&&file.isFile&&digest(file,check)==document.sha256) { "待输出的 PDF 原件已变化" }
        requireCurrent();check()
    }
    fun discard()=synchronized(lifetimeLock){if(discarded.compareAndSet(false,true)){active.remove(file.parentFile!!.name);file.delete();file.parentFile?.delete()};Unit}
    companion object {
        private val lifetimeLock=Any()
        private val active=mutableSetOf<String>()
        private val purging=mutableSetOf<String>()
        /** Only expired, unpinned UUID folders made by this feature; never follows links or deletes unknown files. */
        private fun prune(context:Context,root:File) {
            val cutoff=System.currentTimeMillis()-24L*60*60*1000
            for(dir in root.listFiles().orEmpty()) {
                val id=runCatching{UUID.fromString(dir.name).toString()}.getOrNull()?:continue
                val files=synchronized(lifetimeLock) {
                    if(id!=dir.name||id in active||id in purging||Files.isSymbolicLink(dir.toPath())||!dir.isDirectory||dir.lastModified()>cutoff)return@synchronized null
                    val children=dir.listFiles()?:return@synchronized null
                    if(children.any{Files.isSymbolicLink(it.toPath())||!it.isFile||!(it.name=="original.pdf"||Regex("\\.print-[0-9a-f-]{36}\\.pdf").matches(it.name))})return@synchronized null
                    purging.add(id);children
                }?:continue
                try {
                    val uri=android.net.Uri.Builder().scheme("content").authority(context.packageName+".pdf-originals").appendPath("originals").appendPath(id).appendPath("original.pdf").build()
                    context.revokeUriPermission(uri,android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    require(!Files.isSymbolicLink(dir.toPath())&&dir.absoluteFile==dir.canonicalFile){"输出清理目录身份已变化"}
                    for(file in files)file.delete()
                    dir.delete()
                }finally{synchronized(lifetimeLock){purging.remove(id)}}
            }
        }

        suspend fun prepare(context:Context,repository:PdfRepository,document:PdfDocumentRef,ownerID:String,requireCurrent:()->Unit):PdfOriginalSnapshot {
            val delivery=java.util.concurrent.atomic.AtomicReference<PdfOriginalSnapshot?>()
            try {
                val prepared=withContext(Dispatchers.IO) {
            require(ownerID.isNotBlank()&&ownerID.length<=2048) { "原文没有所属论文身份" };requireCurrent()
            val source=repository.verify(document)
            val root=File(context.cacheDir.canonicalFile,"PdfOutbound")
            require(!Files.isSymbolicLink(root.toPath()));check(root.isDirectory||root.mkdirs());require(root.absoluteFile==root.canonicalFile)
            prune(context,root)
            val dir=File(root,UUID.randomUUID().toString());check(dir.mkdir())
            val output=File(dir,"original.pdf")
            try {
                val call=currentCoroutineContext()
                source.inputStream().use { input->output.outputStream().use{out->copy(input,{b,n->out.write(b,0,n)}){call.ensureActive();requireCurrent()}} }
                require(output.setReadable(false,false)&&output.setReadable(true,true)&&output.setWritable(false,false)&&output.setWritable(true,true)) { "原文分享暂存权限设置失败" }
                require(digest(output)==document.sha256) { "原文输出副本校验失败" }
                requireCurrent();repository.verify(document);call.ensureActive()
                PdfOriginalSnapshot(ownerID,document,output,repository,requireCurrent,source).also(delivery::set)
            }catch(t:Throwable){output.delete();dir.delete();throw t}
                }
                delivery.set(null)
                return prepared
            } catch(failure:Throwable) {
                try{delivery.getAndSet(null)?.discardIfUnhanded()}catch(cleanup:Throwable){failure.addSuppressed(cleanup)}
                throw failure
            }
        }
        internal fun digest(file:File,check:()->Unit={}):String {
            val d=MessageDigest.getInstance("SHA-256")
            file.inputStream().use { copy(it,{b,n->d.update(b,0,n)},check) }
            return d.digest().joinToString(""){"%02x".format(it)}
        }
        internal fun copy(input:InputStream,write:(ByteArray,Int)->Unit,check:()->Unit) {
            val buffer=ByteArray(64*1024);var total=0L
            while(true){check();val n=input.read(buffer);if(n<0)break;if(n==0)continue;total+=n;require(total<=200L*1024*1024){"PDF 输出超过200 MiB限制"};write(buffer,n)}
            check()
        }
    }
}
