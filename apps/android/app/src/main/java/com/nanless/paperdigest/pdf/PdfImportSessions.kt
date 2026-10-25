package com.nanless.paperdigest.pdf

import android.content.Context
import android.content.ContentResolver
import android.net.Uri
import android.provider.OpenableColumns
import com.tom_roush.pdfbox.io.MemoryUsageSetting
import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.pdmodel.encryption.InvalidPasswordException
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.File
import java.io.InputStream
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.BasicFileAttributes
import java.security.MessageDigest
import java.util.IdentityHashMap
import java.util.UUID
import java.util.WeakHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/** Native-only original ciphertext sessions; no source path/password/qualification travels in JSON. */
internal class PdfImportSessions(private val resolver:ContentResolver,private val research:File,private val imports:File,controlPath:File) {
    private val control=directory(controlPath)
    private val controlIdentity=identity(control)
    private val lock=Any()
    private class Slot(val session:PdfImportSession,val folder:File,val rootIdentity:String,val importsIdentity:String,
        val source:File,val folderIdentity:String,val sourceIdentity:String,val mutex:Mutex=Mutex(),val cancelled:AtomicBoolean=AtomicBoolean()) {
        var result:PdfImportedOriginal?=null
        var managed:File?=null
        var managedIdentity:String?=null
        var createdNew=false
        var kept=false
        var secret:CharArray?=null
        var secretScope:PdfSessionSecrets.Scope?=null
    }
    private val active=IdentityHashMap<PdfImportSession,Slot>()
    private val results=IdentityHashMap<PdfImportedOriginal,Slot>()
    private val retired=WeakHashMap<PdfImportSession,Boolean>()
    private val retiredResults=WeakHashMap<PdfImportedOriginal,Boolean>()
    init {require(!control.toPath().startsWith(research.toPath()) && !research.toPath().startsWith(control.toPath())) { "PDF 导入控制目录必须独立于研究资料" }}

    suspend fun prepare(uri:Uri,check:()->Unit):PdfImportSession {
        require(uri.scheme=="content") { "请通过系统文件选择器选择 PDF" }
        val name=withContext(Dispatchers.IO){resolver.query(uri,arrayOf(OpenableColumns.DISPLAY_NAME),null,null,null)?.use{c->if(c.moveToFirst())c.getString(0)else null}?:"本地论文.pdf"}
        return prepare(name,null,check){requireNotNull(resolver.openInputStream(uri)){"原始 PDF 无法读取"}}
    }
    suspend fun prepareFile(file:File,name:String,expectedSHA:String?,check:()->Unit):PdfImportSession {
        require(file.isFile&&!Files.isSymbolicLink(file.toPath())&&file.absoluteFile==file.canonicalFile) { "原始 PDF 文件不可用" }
        return prepare(name,expectedSHA,check){file.inputStream()}
    }
    private suspend fun prepare(name:String,expectedSHA:String?,check:()->Unit,open:()->InputStream):PdfImportSession {
        val delivery=AtomicReference<PdfImportSession?>()
        try {
            val prepared=withContext(Dispatchers.IO) {
                boundary(check);require(expectedSHA==null||Regex("[a-f0-9]{64}").matches(expectedSHA)) { "原 PDF 来源指纹无效" }
                val rootID=identity(research);val importsID=identity(imports)
                val folder=File(control,UUID.randomUUID().toString());kotlin.check(folder.mkdir()) { "无法创建本次 PDF 导入目录" }
                val folderID=identity(folder);val source=File(folder,"original.pdf")
                var published:PdfImportSession?=null
                try {
                    val call=currentCoroutineContext();val hash=MessageDigest.getInstance("SHA-256")
                    open().use{input->java.io.FileOutputStream(source).use{output->copy(input,{b,n->output.write(b,0,n);hash.update(b,0,n)}){call.ensureActive();boundary(check)};output.fd.sync()}}
                    val sha=hash.digest().hex();require(expectedSHA==null||sha==expectedSHA) { "原 PDF 字节与当前来源不符" }
                    require(identity(folder)==folderID) { "PDF 导入目录已被替换" }
                    val sourceID=identity(source)
                    val password=PdfSessionSecrets.copy(research,sha)?:CharArray(0)
                    val locked=try { probe(source,password){call.ensureActive();boundary(check)};false }catch(_:PdfPasswordRequiredException){true}
                    catch(invalid:PdfInvalidDocumentException){
                        // A parser error is continuable only after the complete issued original is reverified.
                        call.ensureActive();boundary(check)
                        require(identity(research)==rootID&&identity(imports)==importsID&&identity(folder)==folderID&&identity(source)==sourceID) { "原 PDF 读取来源已变化" }
                        require(digest(source){call.ensureActive();boundary(check)}==sha&&identity(source)==sourceID&&identity(research)==rootID&&identity(imports)==importsID&&identity(folder)==folderID) { "原 PDF 字节已变化" }
                        throw invalid
                    }finally{password.fill('\u0000')}
                    call.ensureActive();boundary(check);require(identity(research)==rootID&&identity(imports)==importsID) { "研究空间已变化，未接纳旧导入" }
                    val session=PdfImportSession(folder.name,name.replace(Regex("[\\p{Cntrl}/\\\\]"),"_").take(500).ifBlank{"本地论文.pdf"},sha,locked)
                    synchronized(lock){require(active.size<4) { "请先完成或取消已有 PDF 导入" };active[session]=Slot(session,folder,rootID,importsID,source,folderID,sourceID)}
                    published=session;delivery.set(session);session
                }catch(failure:Throwable){
                    if(published==null){source.delete();folder.delete()}
                    throw failure
                }
            }
            delivery.set(null);return prepared
        }catch(failure:Throwable){delivery.getAndSet(null)?.let{withContext(NonCancellable){cancel(it)}};throw failure}
    }
    suspend fun finish(session:PdfImportSession,password:CharArray?,check:()->Unit):PdfImportedOriginal {
        val delivery=AtomicReference<PdfImportedOriginal?>()
        try {
            require(password==null||password.size<=4096) { "PDF 密码过长" }
            val result=withContext(Dispatchers.IO) {
                val slot=lookup(session);val call=currentCoroutineContext();val checkAll={call.ensureActive();boundary(slot,check)}
                slot.mutex.withLock {
                    checkAll();require(slot.result==null) { "此 PDF 已完成原件准备，请接纳或取消原结果" }
                    require(digest(slot.source){checkAll()}==session.sha256) { "待解锁 PDF 原字节已变化" }
                    val secret=password?.copyOf()?:PdfSessionSecrets.copy(research,session.sha256)?:CharArray(0)
                    try {
                        val facts=try{probe(slot.source,secret,checkAll)}catch(failure:PdfPasswordRequiredException){checkAll();throw failure}
                        catch(invalid:PdfInvalidDocumentException){checkAll();require(digest(slot.source){checkAll()}==session.sha256) { "待解锁 PDF 原字节已变化" };checkAll();throw invalid}
                        checkAll()
                        val destination=File(imports,session.sha256+".pdf")
                        var created=false;var newIdentity:String?=null
                        try {
                            try {
                                Files.newOutputStream(destination.toPath(),StandardOpenOption.CREATE_NEW,StandardOpenOption.WRITE).use{out->
                                    created=true;newIdentity=identity(destination)
                                    slot.source.inputStream().use{input->copy(input,{b,n->out.write(b,0,n)}){checkAll()}};out.flush()
                                }
                            }catch(exists:java.nio.file.FileAlreadyExistsException){require(!created);require(destination.isFile&&!Files.isSymbolicLink(destination.toPath())) { "同名原件不可复用" }}
                            if(created)java.nio.channels.FileChannel.open(destination.toPath(),StandardOpenOption.WRITE).use{it.force(true)}
                            checkAll();require(digest(destination){checkAll()}==session.sha256) { "同名原 PDF 字节损坏，未覆盖" }
                            val managedID=identity(destination)
                            val original=PdfImportedOriginal(session.id,PdfDocumentRef("local:"+session.sha256,destination.absolutePath,session.sha256,facts.pages,session.displayName),facts.encrypted,facts.canExtract,facts.canPrint)
                            val secretScope=PdfSessionSecrets.scope(research,session.sha256)
                            synchronized(lock){slot.result=original;slot.managed=destination;slot.managedIdentity=managedID;slot.createdNew=created;slot.secret=if(facts.encrypted&&secret.isNotEmpty())secret.copyOf()else null;slot.secretScope=secretScope;results[original]=slot}
                            delivery.set(original);original
                        }catch(failure:Throwable){if(created&&newIdentity!=null&&sameIdentity(destination,newIdentity!!))destination.delete();throw failure}
                    }finally{secret.fill('\u0000')}
                }
            }
            delivery.set(null);return result
        }catch(failure:Throwable){delivery.getAndSet(null)?.let{withContext(NonCancellable){finalize(it,false)}};throw failure}
        finally{password?.fill('\u0000')}
    }
    /** Valid issued result only. No filesystem or cancellation point after personal metadata commits. */
    fun accept(original:PdfImportedOriginal) {
        synchronized(lock){
            if(retiredResults[original]==true)return
            val slot=requireNotNull(results[original]) { "PDF 接纳资格无效或已取消" }
            if(slot.kept)return
            slot.secret?.let{secret->slot.secretScope?.let{PdfSessionSecrets.putPrepared(it,secret)}}
            slot.kept=true
        }
    }
    suspend fun verify(original:PdfImportedOriginal,check:()->Unit)=withContext(Dispatchers.IO) {
        val slot=synchronized(lock){requireNotNull(results[original]) { "PDF 接纳资格已结束" }}
        val call=currentCoroutineContext();val guard={call.ensureActive();boundary(slot,check)}
        slot.mutex.withLock{guard();require(digest(requireNotNull(slot.managed)){guard()}==original.document.sha256) { "已准备原件字节变化" };require(sameIdentity(requireNotNull(slot.managed),requireNotNull(slot.managedIdentity))) { "已准备原件已被替换" }}
    }
    suspend fun cancel(session:PdfImportSession)=withContext(NonCancellable+Dispatchers.IO) {
        val slot=synchronized(lock){active[session]?:if(retired.containsKey(session))null else throw IllegalArgumentException("PDF 导入会话不属于此实例") }?:return@withContext
        slot.cancelled.set(true)
        slot.mutex.withLock{cleanup(slot)}
    }
    suspend fun finalize(original:PdfImportedOriginal,keep:Boolean) {
        if(keep)accept(original)
        withContext(NonCancellable+Dispatchers.IO){
            val slot=synchronized(lock){results[original]?:if(retiredResults.containsKey(original))null else throw IllegalArgumentException("PDF 原件准备资格不属于此实例") }?:return@withContext
            slot.mutex.withLock{cleanup(slot)}
        }
    }
    private fun cleanup(slot:Slot) {
        if(!slot.kept&&slot.createdNew){val managed=slot.managed;val expected=slot.managedIdentity;if(managed!=null&&expected!=null&&sameIdentity(managed,expected)&&runCatching{identity(research)==slot.rootIdentity&&identity(imports)==slot.importsIdentity&&digest(managed){}==slot.session.sha256&&sameIdentity(managed,expected)}.getOrDefault(false))managed.delete()}
        // Only the exact issued control directory and its known regular file.
        if(runCatching{identity(control)==controlIdentity&&identity(slot.folder)==slot.folderIdentity}.getOrDefault(false)&&slot.folder.parentFile==control){
            if(sameIdentity(slot.source,slot.sourceIdentity))slot.source.delete();slot.folder.delete()
        }
        synchronized(lock){slot.secret?.fill('\u0000');slot.secret=null;active.remove(slot.session);retired[slot.session]=slot.kept;slot.result?.let{results.remove(it);retiredResults[it]=slot.kept}}
    }
    private fun lookup(session:PdfImportSession)=synchronized(lock){requireNotNull(active[session]) { "PDF 导入会话无效或已结束" }}
    private fun boundary(check:()->Unit){check();require(identity(control)==controlIdentity) { "PDF 导入控制目录已变化" }}
    private fun boundary(slot:Slot,check:()->Unit){if(slot.cancelled.get())throw CancellationException("已取消 PDF 解锁；原文件保留");boundary(check);require(identity(research)==slot.rootIdentity&&identity(imports)==slot.importsIdentity&&identity(slot.folder)==slot.folderIdentity&&identity(slot.source)==slot.sourceIdentity) { "研究空间已变化，未接纳旧 PDF" }}
    private data class Facts(val pages:Int,val encrypted:Boolean,val canExtract:Boolean,val canPrint:Boolean)
    private fun probe(file:File,password:CharArray,check:()->Unit={}):Facts {
        // Independent content fact, before opening PDFBox or any scratch file. Scan the bounded
        // complete original, so an otherwise accepted long preamble gains no new 1024-byte limit.
        if(!hasPDFSignature(file,check))throw PdfInvalidDocumentException("文件已完整读取，但没有 PDF 文件头，未导入此文件")
        val facts=try {
            PDDocument.load(file,String(password),MemoryUsageSetting.setupMixed(4L*1024*1024,512L*1024*1024)).use{pdf->
                Facts(pdf.numberOfPages,pdf.isEncrypted,pdf.currentAccessPermission.canExtractContent(),pdf.currentAccessPermission.canPrint())
            }
        }catch(_:InvalidPasswordException){throw PdfPasswordRequiredException()}
        // Only after normal close: parser/scratch/close IOException must retain its original type.
        if(facts.pages==0)throw PdfInvalidDocumentException("PDF 已完整解析，但没有可用的物理页面")
        return facts
    }
    private fun hasPDFSignature(file:File,check:()->Unit):Boolean {
        val marker=byteArrayOf(37,80,68,70,45);val bytes=ByteArray(65536);var matched=0
        file.inputStream().use{input->
            while(true){check();val count=input.read(bytes);if(count<0)break;if(count==0)continue
                for(index in 0 until count){val value=bytes[index];matched=if(value==marker[matched])matched+1 else if(value==marker[0])1 else 0;if(matched==marker.size){check();return true}}
            }
        }
        check();return false
    }
    private fun directory(file:File):File {require(file.absoluteFile==file.canonicalFile) { "PDF 控制目录不能是链接" };var p:File?=file;while(p!=null){require(!Files.isSymbolicLink(p.toPath())) { "PDF 目录不能是链接" };p=p.parentFile};check(file.isDirectory||file.mkdirs()) { "PDF 控制目录不可用" };return file}
    private fun identity(file:File):String {require(file.absoluteFile==file.canonicalFile&&!Files.isSymbolicLink(file.toPath())) { "PDF 路径已变化" };return requireNotNull(Files.readAttributes(file.toPath(),BasicFileAttributes::class.java,LinkOption.NOFOLLOW_LINKS).fileKey()) { "PDF 路径身份不可核对" }.toString()}
    private fun sameIdentity(file:File,expected:String)=runCatching{identity(file)==expected}.getOrDefault(false)
    private fun digest(file:File,check:()->Unit):String {val hash=MessageDigest.getInstance("SHA-256");file.inputStream().use{copy(it,{b,n->hash.update(b,0,n)},check)};return hash.digest().hex()}
    private fun copy(input:InputStream,write:(ByteArray,Int)->Unit,check:()->Unit){val bytes=ByteArray(65536);var total=0L;while(true){check();val n=input.read(bytes);if(n<0)break;if(n==0)continue;total+=n;require(total<=200L*1024*1024) { "PDF 超过200MiB，原件未修改" };write(bytes,n)};check()}
    private fun ByteArray.hex()=joinToString(""){"%02x".format(it.toInt() and 255)}
}
