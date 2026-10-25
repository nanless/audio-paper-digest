package com.nanless.paperdigest

import com.nanless.paperdigest.ui.PdfUnlockPrompt

import kotlinx.coroutines.*

/** One native import scope owns the wait and its drain. A UI submission only transfers a short-lived array. */
internal class PdfUnlockMailbox(private val publish:(PdfUnlockPrompt?)->Unit) {
    private class Answer(value:CharArray) {
        private var value:CharArray?=value
        fun borrow():CharArray = synchronized(this) { value ?: error("本次解锁输入已清除，请重新输入") }
        fun close()=synchronized(this){ value?.fill('\u0000');value=null }
    }
    private class Entry(val view:PdfUnlockPrompt,val owner:Job,val check:()->Unit) {
        val delivered=CompletableDeferred<Unit>(owner)
        var answer:Answer?=null
        var stopping=false
    }
    private val lock=Any()
    private var current:Entry?=null

    suspend fun <T> awaitAndUse(view:PdfUnlockPrompt,check:()->Unit,lifetime:Job?=null,use:suspend(CharArray)->T):T {
        val operation=currentCoroutineContext();operation.ensureActive();check()
        val owner=lifetime?:operation[Job]?:error("缺少原生解锁作业")
        check(owner.isActive){"原生解锁作业已结束"}
        val entry=Entry(view,owner,check)
        synchronized(lock) {
            require(current==null){"请先结束上一份 PDF 的解锁操作"}
            current=entry
        }
        try {
            synchronized(lock){if(current===entry)publish(view)}
            entry.delivered.await()
            operation.ensureActive();check()
            val answer=synchronized(lock){
                require(current===entry&&!entry.stopping){"原文解锁请求已失效"}
                entry.answer?:error("缺少本次解锁输入")
            }
            synchronized(lock){if(current===entry&&!entry.stopping)publish(view.copy(checking=true))}
            operation.ensureActive();check()
            return use(answer.borrow())
        } finally {
            // Kept until the actual parser/use block has unwound; cancellation is not a fake terminal result.
            synchronized(lock){
                entry.answer?.close();entry.answer=null;entry.delivered.cancel()
                if(current===entry){current=null;publish(null)}
            }
        }
    }

    fun submit(requestID:String,password:CharArray) {
        try {
            synchronized(lock) {
                val entry=current
                require(entry!=null&&entry.view.requestID==requestID&&entry.owner.isActive&&!entry.stopping&&!entry.delivered.isCompleted){"原文解锁请求已结束，请按当前窗口重新输入"}
                entry.check()
                val answer=Answer(password.copyOf());entry.answer=answer
                publish(entry.view.copy(checking=true))
                if(!entry.delivered.complete(Unit)) {
                    answer.close();entry.answer=null
                    error("原文解锁请求已结束，请重新打开当前原件")
                }
            }
        } finally { password.fill('\u0000') }
    }

    /** No lock is held while a caller later joins this job or while native parsing drains. */
    fun requestStop(requestID:String?=null):Job? {
        val entry=synchronized(lock) {
            current?.takeIf{requestID==null||it.view.requestID==requestID}?.also{
                it.stopping=true
                publish(it.view.copy(checking=true,stopping=true,message="已请求停止，正在等待原文操作关闭；原件保留。"))
            }
        }?:return null
        entry.owner.cancel(CancellationException("已取消本次原文解锁"))
        return entry.owner
    }
}
