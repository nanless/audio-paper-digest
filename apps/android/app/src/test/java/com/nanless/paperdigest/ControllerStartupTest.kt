package com.nanless.paperdigest

import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ControllerStartupTest {
    @Test fun concurrentActivityAndWorkerWaitersShareOneProducer()=runTest {
        val app=CoroutineScope(SupervisorJob()+StandardTestDispatcher(testScheduler));val release=CompletableDeferred<Unit>();var starts=0;val native=Any()
        try {
            val startup=ControllerStartup(app){starts++;release.await();native}
            val first=async{startup.await()};val worker=async{startup.await()};runCurrent();assertEquals(1,starts)
            release.complete(Unit);assertSame(native,first.await());assertSame(native,worker.await())
        }finally{app.cancel()}
    }
    @Test fun activityCancellationDoesNotCancelApplicationInitialization()=runTest {
        val app=CoroutineScope(SupervisorJob()+StandardTestDispatcher(testScheduler));val release=CompletableDeferred<Unit>();var starts=0
        try {
            val startup=ControllerStartup(app){starts++;release.await();"native"}
            val activity=launch{startup.await()};runCurrent();activity.cancelAndJoin()
            release.complete(Unit);assertEquals("native",startup.await());assertEquals(1,starts)
        }finally{app.cancel()}
    }
    @Test fun failureIsRetainedUntilAnExplicitRetryAndSuccessIsNeverReconstructed()=runTest {
        val app=CoroutineScope(SupervisorJob()+StandardTestDispatcher(testScheduler));var starts=0
        try {
            val startup=ControllerStartup(app){starts++;if(starts==1)error("synthetic corrupt catalog");"native"}
            repeat(3){assertTrue(runCatching{startup.await()}.isFailure)};assertEquals(1,starts)
            assertEquals("native",startup.await(retry=true));assertEquals(2,starts)
            assertEquals("native",startup.await(retry=true));assertEquals(2,starts)
        }finally{app.cancel()}
    }
    @Test fun repeatedRetryWhileLoadingNeverCreatesAnotherStore()=runTest {
        val app=CoroutineScope(SupervisorJob()+StandardTestDispatcher(testScheduler));val release=CompletableDeferred<Unit>();var starts=0
        try {
            val startup=ControllerStartup(app){starts++;release.await();"native"};val first=startup.start()
            assertSame(first,startup.start(retry=true));runCurrent();assertEquals(1,starts)
            release.complete(Unit);assertEquals("native",first.await())
        }finally{app.cancel()}
    }
}
