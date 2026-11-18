package com.nanless.paperdigest

import android.os.SystemClock
import com.nanless.paperdigest.data.*
import com.nanless.paperdigest.ui.AggregateViewLease
import com.nanless.paperdigest.ui.ids
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject
import java.util.Collections
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

/** Domain port decoupling catalog/aggregate background maintenance from Android Context/WorkManager. */
internal interface CatalogMaintenancePort {
    fun summary(): JSONObject
    suspend fun hasPublishedCatalogUpdate(): Boolean
    suspend fun sync(onProgress: (Int, Int, String) -> Unit): JSONObject
    fun aggregateStamp(): AggregateCatalogStamp
    suspend fun aggregateCatalog(): PublishedAggregateCatalog?
    suspend fun preloadAggregateDocument(
        id: String,
        expected: AggregateCatalogStamp,
        withCommitLock: suspend (() -> Unit) -> Unit,
    )
    fun papers(): List<Paper>
    suspend fun preloadArticle(paper: Paper)
}

/** Coordinates foreground priority draining, automatic catalog refresh probes, aggregate view leases, and preloading. */
internal class CatalogMaintenanceCoordinator(
    private val installBackground: Boolean,
    private val foregroundOwners: MutableSet<Any>,
    private val scope: () -> CoroutineScope,
    private val maintenance: () -> Mutex,
    private val settings: () -> JSONObject,
    private val library: CatalogMaintenancePort,
    private val hasActiveTasks: () -> Boolean,
    private val hasSelectedAggregate: () -> Boolean,
    private val readingGeneration: () -> Long,
    private val pauseAggregatePreviews: () -> Unit,
    private val resumeAggregatePreviews: () -> Unit,
    private val enterAggregateBrowser: () -> Unit,
    private val leaveAggregateBrowser: () -> Unit,
    private val retireAggregateBrowser: () -> Unit,
    private val executeAggregateBrowser: suspend (String, JSONObject, () -> Boolean, () -> Boolean) -> JSONObject,
    private val runTask: suspend (String, suspend () -> JSONObject) -> JSONObject,
    private val onCatalogCheckedAt: (String) -> Unit,
    private val onNotice: (String) -> Unit,
    private val onRefresh: () -> Unit,
    private val updatePeriodicSchedule: (CatalogRefreshSettings) -> Unit,
    private val elapsedRealtimeMillis: () -> Long = { SystemClock.elapsedRealtime() },
    private val currentTimeMillis: () -> Long = { System.currentTimeMillis() },
    private val nowIso: () -> String = { now() },
) {
    val aggregateViewRevision = AtomicLong(0)
    val publishedPreload = AtomicReference<Job?>(null)
    val automaticCatalogJob = AtomicReference<Job?>(null)
    val articleReadJob = AtomicReference<Job?>(null)
    val catalogSyncAdmission = Mutex()

    private val automaticCatalogPolicy = CatalogRefreshPolicy()
    private val foregroundCatalogIntervalMillis = 60_000L
    @Volatile private var lastCatalogCheckElapsed: Long? = null
    private val foregroundOperations = AtomicInteger(0)
    private val readingViewOwners = Collections.newSetFromMap(ConcurrentHashMap<Any, Boolean>())
    private var scheduledCatalogSettings: CatalogRefreshSettings? = null
    @Volatile private var preloadedCatalog: AggregateCatalogStamp? = null
    private val aggregateImageJobs = ConcurrentHashMap.newKeySet<Job>()

    fun workspaceRestored() {
        preloadedCatalog = null
        if (installBackground) {
            scheduleCatalog()
        }
    }

    fun catalogProbeDue(): Boolean {
        val last = lastCatalogCheckElapsed ?: return true
        return elapsedRealtimeMillis() - last >= foregroundCatalogIntervalMillis
    }

    fun catalogCheckCompleted() {
        lastCatalogCheckElapsed = elapsedRealtimeMillis()
        automaticCatalogPolicy.completed()
        onCatalogCheckedAt(nowIso())
    }

    fun onValidatedNetworkAvailable() {
        lastCatalogCheckElapsed = null
        automaticCatalogPolicy.completed()
        scope().launch { scheduleAutomaticCatalogCheck() }
    }

    fun startPeriodicProbeLoop() {
        scope().launch {
            while (isActive) {
                delay(foregroundCatalogIntervalMillis)
                scheduleAutomaticCatalogCheck()
            }
        }
    }

    fun cancelPublishedPreload() {
        publishedPreload.get()?.cancel()
    }

    suspend fun drainBackground(reference: AtomicReference<Job?>) {
        val job = reference.get() ?: return
        if (job === currentCoroutineContext()[Job]) return
        job.cancelAndJoin()
        reference.compareAndSet(job, null)
    }

    suspend fun giveForegroundPriority() {
        drainBackground(automaticCatalogJob)
        drainBackground(publishedPreload)
        drainBackground(articleReadJob)
    }

    fun isForegroundCommand(command: String): Boolean =
        command !in setOf("app.bootstrap", "personal.reading", "zotero.state", "cloud.state")

    fun beginForegroundOperation(command: String): Boolean {
        val prioritized = isForegroundCommand(command)
        if (prioritized) foregroundOperations.incrementAndGet()
        return prioritized
    }

    fun finishForegroundOperation(command: String) {
        if (foregroundOperations.decrementAndGet() == 0 && command != "jobs.cancel") {
            scheduleAutomaticCatalogCheck()
        }
    }

    fun readingViewVisible(owner: Any, visible: Boolean) {
        if (visible) readingViewOwners.add(owner)
        else if (readingViewOwners.remove(owner) && readingViewOwners.isEmpty()) scheduleAutomaticCatalogCheck()
    }

    fun foregroundStarted(owner: Any) {
        if (!installBackground || !foregroundOwners.add(owner)) return
        scheduleAutomaticCatalogCheck()
    }

    fun foregroundStopped(owner: Any) {
        foregroundOwners.remove(owner)
    }

    private fun automaticCatalogInputs(): Triple<CatalogRefreshSettings, Boolean, String?> {
        val refreshSettings = CatalogRefreshSettings.from(settings())
        val summary = library.summary()
        val hasCatalog = summary.optString("snapshotID") !in setOf("", "unsynced", "bundled-sample") &&
            summary.optInt("paperCount") > 0
        return Triple(refreshSettings, hasCatalog, summary.nullableString("syncedAt"))
    }

    fun scheduleAutomaticCatalogCheck() {
        if (!installBackground || foregroundOwners.isEmpty() || foregroundOperations.get() > 0 ||
            hasActiveTasks() || readingViewOwners.isNotEmpty() || hasSelectedAggregate() ||
            articleReadJob.get()?.isCompleted == false
        ) return
        val input = automaticCatalogInputs()
        if (!automaticCatalogPolicy.eligible(input.first, input.second, input.third, currentTimeMillis(), catalogProbeDue())) return
        lateinit var work: Job
        work = scope().launch(start = CoroutineStart.LAZY) { performAutomaticCatalogSync(1_500, work) }
        if (automaticCatalogJob.compareAndSet(null, work)) work.start() else work.cancel()
    }

    suspend fun performAutomaticCatalogSync(initialDelayMillis: Long = 0, registeredOwner: Job? = null): Boolean =
        withContext(Dispatchers.IO) {
            val job = registeredOwner ?: currentCoroutineContext()[Job]!!
            if (registeredOwner == null) {
                if (!automaticCatalogJob.compareAndSet(null, job)) return@withContext false
            } else if (automaticCatalogJob.get() !== registeredOwner) {
                return@withContext false
            }
            var admitted = false
            var previewsPaused = false
            var attempt: Long? = null
            try {
                if (initialDelayMillis > 0) delay(initialDelayMillis)
                if (initialDelayMillis > 0 && foregroundOwners.isEmpty()) return@withContext false
                if (foregroundOwners.isNotEmpty() && (readingViewOwners.isNotEmpty() || hasSelectedAggregate())) return@withContext false
                if (foregroundOperations.get() > 0 || hasActiveTasks() || articleReadJob.get()?.isCompleted == false) return@withContext false
                if (!catalogSyncAdmission.tryLock()) return@withContext false
                admitted = true
                val input = automaticCatalogInputs()
                val nowMillis = currentTimeMillis()
                val probe = initialDelayMillis > 0 && catalogProbeDue()
                val fullSync = CatalogRefreshPolicy.due(input.second, input.third, input.first.hours, nowMillis)
                attempt = automaticCatalogPolicy.begin(input.first, input.second, input.third, nowMillis, probe) ?: return@withContext false
                if (!fullSync && !library.hasPublishedCatalogUpdate()) {
                    catalogCheckCompleted()
                    return@withContext true
                }
                drainBackground(publishedPreload)
                currentCoroutineContext().ensureActive()
                pauseAggregatePreviews()
                previewsPaused = true
                runTask("library.sync.automatic") {
                    maintenance().withLock {
                        currentCoroutineContext().ensureActive()
                        require(!settings().optBoolean("offlineMode")) { "当前为离线模式" }
                        library.sync { _, _, message -> onNotice(message) }
                    }
                }
                catalogCheckCompleted()
                schedulePublishedPreload()
                true
            } catch (cancelled: CancellationException) {
                automaticCatalogPolicy.cancelled(attempt)
                throw cancelled
            } catch (_: Exception) {
                onNotice("自动检查暂未完成，已保存的目录仍可阅读；联网恢复后会自动检查。")
                false
            } finally {
                if (previewsPaused) resumeAggregatePreviews()
                if (admitted) catalogSyncAdmission.unlock()
                automaticCatalogJob.compareAndSet(job, null)
            }
        }

    suspend fun executeManualLibrarySync(command: String): JSONObject {
        if (!catalogSyncAdmission.tryLock()) return JSONObject().put("status", "sync-in-progress")
        return try {
            runTask(command) {
                maintenance().withLock {
                    library.sync { _, _, message -> onNotice(message) }
                }
            }.also {
                catalogCheckCompleted()
                schedulePublishedPreload()
            }
        } finally {
            catalogSyncAdmission.unlock()
        }
    }

    fun schedulePublishedPreload() {
        val expected = library.aggregateStamp()
        if (settings().optBoolean("offlineMode") || preloadedCatalog == expected || publishedPreload.get()?.isCompleted == false) return
        val work = scope().launch(start = CoroutineStart.LAZY) {
            try {
                val catalog = maintenance().withLock { library.aggregateCatalog() } ?: return@launch
                val records = workbenchAggregateOrder(catalog.records)
                val targets = (
                    records.filter { it.kind == "daily" }.take(2) +
                        records.filter { workbenchConferenceDirectory(it) }.take(1) +
                        records.filter { it.kind == "conference" && !workbenchConferenceTask(it) }.take(1)
                    ).distinctBy { it.id }
                for (record in targets) {
                    ensureActive()
                    if (library.aggregateStamp() != expected || settings().optBoolean("offlineMode")) return@launch
                    try {
                        library.preloadAggregateDocument(record.id, expected) { commit ->
                            maintenance().withLock { ensureActive(); commit() }
                        }
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (_: Exception) {
                        /* Optional prefetch never grants display or overwrites the last readable version. */
                    }
                }
                val retired = library.summary().ids("missingFromLatest").toSet()
                val latest = library.papers().asSequence()
                    .filter { it.sourceKind != "local" && it.blogURL.isNotBlank() && it.id !in retired }
                    .sortedByDescending { it.date }
                    .take(2)
                    .toList()
                for (paper in latest) {
                    ensureActive()
                    if (library.aggregateStamp() != expected || settings().optBoolean("offlineMode")) return@launch
                    try {
                        maintenance().withLock {
                            ensureActive()
                            require(library.aggregateStamp() == expected && !settings().optBoolean("offlineMode"))
                            library.preloadArticle(paper)
                        }
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (_: Exception) {
                        /* Explicit reads keep their own visible errors. */
                    }
                }
                if (library.aggregateStamp() == expected) preloadedCatalog = expected
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                /* Foreground reads retain their normal visible errors. */
            } finally {
                publishedPreload.compareAndSet(currentCoroutineContext()[Job], null)
            }
        }
        val old = publishedPreload.get()
        if (old?.isCompleted == false || !publishedPreload.compareAndSet(old, work)) work.cancel() else work.start()
    }

    @Synchronized
    fun scheduleCatalog() {
        if (!installBackground) return
        val next = CatalogRefreshSettings.from(settings())
        if (scheduledCatalogSettings == next) return
        updatePeriodicSchedule(next)
        scheduledCatalogSettings = next
    }

    suspend fun <T> trackAggregateImage(block: suspend () -> T): T {
        val job = currentCoroutineContext()[Job]!!
        aggregateImageJobs.add(job)
        return try {
            block()
        } finally {
            aggregateImageJobs.remove(job)
        }
    }

    fun cancelAggregateImages() {
        aggregateImageJobs.toList().forEach {
            it.cancel(CancellationException("已切换阅读，停止原页图片等待"))
        }
    }

    fun captureAggregateView(): AggregateViewLease =
        AggregateViewLease(aggregateViewRevision.get(), readingGeneration())

    fun enterAggregateView() {
        aggregateViewRevision.incrementAndGet()
        enterAggregateBrowser()
    }

    fun leaveAggregateView() {
        cancelPublishedPreload()
        cancelAggregateImages()
        aggregateViewRevision.incrementAndGet()
        leaveAggregateBrowser()
    }

    fun retireAggregateView() {
        cancelAggregateImages()
        aggregateViewRevision.incrementAndGet()
        retireAggregateBrowser()
    }

    suspend fun executeAggregateInView(command: String, payload: JSONObject, lease: AggregateViewLease): JSONObject {
        if (captureAggregateView() != lease) return JSONObject().put("status", "not-adopted")
        foregroundOperations.incrementAndGet()
        try {
            giveForegroundPriority()
            if (captureAggregateView() != lease) return JSONObject().put("status", "not-adopted")
            if (command != "aggregate.list") cancelPublishedPreload()
            if (command in setOf("aggregate.select", "aggregate.resume", "aggregate.back", "aggregate.close", "aggregate.list", "aggregate.refresh", "aggregate.cached", "aggregate.link")) {
                cancelAggregateImages()
            }
            val viewGuard = { aggregateViewRevision.get() == lease.navigationEpoch }
            val claimGuard = { readingGeneration() == lease.readingEpoch }
            if (command == "aggregate.close") return executeAggregateBrowser(command, payload.copy(), viewGuard, claimGuard)
            return withContext(Dispatchers.IO) {
                val result = executeAggregateBrowser(command, payload.copy(), viewGuard, claimGuard)
                onRefresh()
                if (command == "aggregate.list" && result.optString("status") == "index-ready") {
                    schedulePublishedPreload()
                }
                result
            }
        } finally {
            finishForegroundOperation(command)
        }
    }
}
