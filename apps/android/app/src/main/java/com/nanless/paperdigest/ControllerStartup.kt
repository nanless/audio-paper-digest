package com.nanless.paperdigest

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async

/** One Application-owned initialization. Cancelling an Activity waiter does not cancel its producer. */
internal class ControllerStartup<T : Any>(private val scope: CoroutineScope, private val create: suspend () -> T) {
    private var attempt: Deferred<T>? = null

    @Synchronized
    fun start(retry: Boolean = false): Deferred<T> {
        val old = attempt
        if (old != null && (!retry || !old.isCompleted || !old.isCancelled)) return old
        return scope.async(start = CoroutineStart.LAZY) { create() }.also { attempt = it; it.start() }
    }

    suspend fun await(retry: Boolean = false): T = start(retry).await()
}
