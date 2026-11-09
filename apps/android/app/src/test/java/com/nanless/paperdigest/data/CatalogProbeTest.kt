package com.nanless.paperdigest.data

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The foreground probe and [CatalogRepository.sync] must read the same catalog entry. */
class CatalogProbeTest {
    private val client = CatalogRepository.SITE + "client/index.json"
    private val legacy = CatalogRepository.SITE + "index.json"

    @Test fun probeComparesTheSameEntryBytesThatSyncStored() = runBlocking {
        val clientBytes = """{"contract":"paper-search-index-manifest","recordCount":1}""".toByteArray()
        val legacyBytes = """[{"permalink":"legacy-entry"}]""".toByteArray()
        val (url, bytes) = CatalogRepository.catalogIndexEntry { if (it == client) clientBytes else legacyBytes }
        assertEquals(client, url)
        assertArrayEquals(clientBytes, bytes)
        // sync 写入的 snapshotID 来自同一入口；两个地址字节不同时不能被当成新目录反复全量同步。
        assertFalse(CatalogRepository.catalogUpdateDetected(bytes, sha256(clientBytes)))
        assertTrue(CatalogRepository.catalogUpdateDetected(bytes, sha256(legacyBytes)))
        assertTrue(CatalogRepository.catalogUpdateDetected(clientBytes, "unsynced"))
    }

    @Test fun probeFallsBackToLegacyIndexOnlyWhenPreferredEntryIsMissing() = runBlocking {
        val legacyBytes = """[{"permalink":"legacy-entry"}]""".toByteArray()
        val requested = mutableListOf<String>()
        val (url, bytes) = CatalogRepository.catalogIndexEntry { address ->
            requested += address
            if (address == client) throw PublishedHttpStatus(404) else legacyBytes
        }
        assertEquals(legacy, url)
        assertArrayEquals(legacyBytes, bytes)
        assertEquals(listOf(client, legacy), requested)

        val gone = mutableListOf<String>()
        var failure: Throwable? = null
        try {
            CatalogRepository.catalogIndexEntry { address ->
                gone += address
                throw PublishedHttpStatus(if (address == client) 410 else 404)
            }
        } catch (error: Throwable) { failure = error }
        assertTrue("missing preferred and legacy entry is not a snapshot", failure is PublishedHttpStatus)
        assertEquals(listOf(client, legacy), gone)
    }

    @Test fun probeNeverFallsBackForOtherHttpStatuses() = runBlocking {
        val requested = mutableListOf<String>()
        var failure: Throwable? = null
        try {
            CatalogRepository.catalogIndexEntry { address ->
                requested += address
                throw PublishedHttpStatus(503)
            }
        } catch (error: Throwable) { failure = error }
        assertTrue(failure is PublishedHttpStatus)
        assertEquals(503, (failure as PublishedHttpStatus).status)
        assertEquals(listOf(client), requested)
    }
}
