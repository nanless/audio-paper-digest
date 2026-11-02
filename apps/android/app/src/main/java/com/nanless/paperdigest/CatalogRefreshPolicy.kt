package com.nanless.paperdigest

import java.time.Instant
import java.time.temporal.ChronoUnit

/** Scheduling hints only. These values never grant catalog or reading-source eligibility. */
internal data class CatalogRefreshSettings(val offline: Boolean, val hours: Long) {
    companion object {
        fun from(settings: org.json.JSONObject) = CatalogRefreshSettings(
            settings.optBoolean("offlineMode"), settings.optLong("syncHours", 12).coerceIn(1, 168))
    }
}

internal class CatalogRefreshPolicy(private val failureCooldownMillis: Long = 5 * 60_000L) {
    private data class Attempt(val token: Long, val atMillis: Long)
    private var lastAttempt: Attempt? = null
    private var sequence = 0L

    @Synchronized
    fun eligible(settings: CatalogRefreshSettings, hasCatalog: Boolean, syncedAt: String?, nowMillis: Long): Boolean {
        if (settings.offline || !due(hasCatalog, syncedAt, settings.hours, nowMillis)) return false
        val previous = lastAttempt
        return previous == null || nowMillis < previous.atMillis || nowMillis - previous.atMillis >= failureCooldownMillis
    }

    @Synchronized
    fun begin(settings: CatalogRefreshSettings, hasCatalog: Boolean, syncedAt: String?, nowMillis: Long): Long? {
        if (!eligible(settings, hasCatalog, syncedAt, nowMillis)) return null
        val attempt = Attempt(++sequence, nowMillis); lastAttempt = attempt
        return attempt.token
    }

    /** A foreground action yielding the network is not a failed attempt or a new cooldown. */
    @Synchronized fun cancelled(token: Long?) { if (token != null && lastAttempt?.token == token) lastAttempt = null }
    @Synchronized fun completed() { lastAttempt = null }

    companion object {
        fun due(hasCatalog: Boolean, syncedAt: String?, hours: Long, nowMillis: Long): Boolean {
            if (!hasCatalog) return true
            val now = Instant.ofEpochMilli(nowMillis)
            val saved = try { Instant.parse(syncedAt ?: return true) } catch (_: Exception) { return true }
            // Clock changes must not leave the library permanently "fresh" in the future.
            if (saved.isAfter(now)) return true
            return try { !saved.plus(hours.coerceIn(1, 168), ChronoUnit.HOURS).isAfter(now) }
            catch (_: Exception) { true }
        }
    }
}
