package com.nanless.paperdigest.review

import android.content.ContextWrapper
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.nanless.paperdigest.RootController
import com.nanless.paperdigest.data.*
import kotlinx.coroutines.*
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.nio.file.Files
import java.util.UUID

/** Actual Root construction; all aliases and outside targets are owned synthetic fixture paths. */
@RunWith(AndroidJUnit4::class)
class RootResearchDirectoryInstrumentedTest {
    @Test fun controlledResearchSymlinkIsRejectedBeforePersonalStoreCanRetireOutsideRunningRecord() = runBlocking {
        val target = InstrumentationRegistry.getInstrumentation().targetContext
        val home = File(target.cacheDir, "ResearchRoot-${UUID.randomUUID()}").canonicalFile.apply { mkdirs() }
        val base = File(home, "NativeBase").apply { mkdir() }
        val outside = File(home, "OwnedOutside").apply { mkdir() }
        val store = PersonalStore(outside)
        store.upsertJob(JSONObject().put("id", UUID.randomUUID().toString()).put("kind", "model.run")
            .put("paperID", "").put("status", "running").put("createdAt", now()).put("startedAt", now()))
        val before = File(outside, "personal.json").readBytes()
        val originalNames = outside.list()!!.toSet()
        Files.createSymbolicLink(File(base, "PaperDigest").toPath(), outside.toPath())
        val context = object : ContextWrapper(target) { override fun getNoBackupFilesDir() = base }
        var unexpected: RootController? = null
        try {
            val outcome = runCatching { RootController(context, installBackground = false).also { unexpected = it } }
            assertTrue("Controlled child link must be rejected before constructing PersonalStore/Library", outcome.isFailure)
            assertArrayEquals("No interruption marker may be written through the controlled link", before, File(outside, "personal.json").readBytes())
            assertEquals(originalNames, outside.list()!!.toSet())
            assertFalse(File(base, "PaperDigestTransfers").exists())
        } finally {
            unexpected?.let { stop(it) }
            Files.deleteIfExists(File(base, "PaperDigest").toPath()); home.deleteRecursively()
        }
    }
    @Test fun trustedNativeBaseAliasAndMissingNormalResearchDirectoryStillBootstrap() = runBlocking {
        val target = InstrumentationRegistry.getInstrumentation().targetContext
        val home = File(target.cacheDir, "ResearchBase-${UUID.randomUUID()}").canonicalFile.apply { mkdirs() }
        val base = File(home, "NativeBase").apply { mkdir() }; val alias = File(home, "NativeAlias")
        Files.createSymbolicLink(alias.toPath(), base.toPath())
        val context = object : ContextWrapper(target) { override fun getNoBackupFilesDir() = alias }
        var root: RootController? = null
        try {
            val current = RootController(context, installBackground = false)
            root = current
            withTimeout(10000) { while (current.state.value.pendingExportsLoading) delay(5) }
            assertTrue(current.execute("app.bootstrap", JSONObject()).getBoolean("ready"))
            assertTrue(File(base, "PaperDigest/personal.json").isFile)
            assertFalse(Files.isSymbolicLink(File(base, "PaperDigest").toPath()))
            assertEquals(0, current.personal.snapshot().getJSONArray("sessions").length())
        } finally { root?.let { stop(it) }; Files.deleteIfExists(alias.toPath()); home.deleteRecursively() }
    }
    @Test fun regularFileAtResearchChildIsNotOverwrittenByRootStartup() {
        val target = InstrumentationRegistry.getInstrumentation().targetContext
        val home = File(target.cacheDir, "ResearchFile-${UUID.randomUUID()}").canonicalFile.apply { mkdirs() }
        val child = File(home, "PaperDigest").apply { writeBytes(byteArrayOf(6, 1, 0, -1)) }
        val context = object : ContextWrapper(target) { override fun getNoBackupFilesDir() = home }
        try {
            assertTrue(runCatching { RootController(context, installBackground = false) }.isFailure)
            assertArrayEquals(byteArrayOf(6, 1, 0, -1), child.readBytes())
            assertEquals(setOf("PaperDigest"), home.list()!!.toSet())
        } finally { home.deleteRecursively() }
    }
    @Test fun controlledCapacityAncestorLinkFailsOnlyOnExplicitMeasurementWithoutBlockingBootstrap() = runBlocking {
        val target = InstrumentationRegistry.getInstrumentation().targetContext
        val home = File(target.cacheDir, "RootCapacity-${UUID.randomUUID()}").canonicalFile.apply { mkdirs() }
        val base = File(home, "NativeBase").apply { mkdir() }; val research = File(base, "PaperDigest")
        val outside = File(home, "OwnedOutside").apply { mkdir() }; val exports = File(outside, "Exports").apply { mkdir() }
        val sentinel = File(exports, "sentinel").apply { writeBytes(byteArrayOf(9, 3, 1, -1)) }
        PersonalStore(research).updateSettings(JSONObject().put("offlineMode", true))
        val before = File(research, "personal.json").readBytes()
        Files.createSymbolicLink(File(base, "PaperDigestTransfers").toPath(), outside.toPath())
        val context = object : ContextWrapper(target) { override fun getNoBackupFilesDir() = base }
        var root: RootController? = null
        try {
            val current = RootController(context, installBackground = false); root = current
            withTimeout(10000) { while (current.state.value.pendingExportsLoading) delay(5) }
            assertFalse(current.state.value.pendingExportsError.isNullOrBlank())
            assertTrue(current.execute("app.bootstrap", JSONObject()).getBoolean("ready"))
            assertTrue(runCatching { current.execute("storage.capacity", JSONObject()) }.isFailure)
            assertArrayEquals(before, File(research, "personal.json").readBytes())
            assertArrayEquals(byteArrayOf(9, 3, 1, -1), sentinel.readBytes())
            assertEquals(listOf("sentinel"), exports.list()!!.toList())
            assertEquals(0, current.personal.snapshot().getJSONArray("sessions").length())
        } finally { root?.let { stop(it) }; Files.deleteIfExists(File(base, "PaperDigestTransfers").toPath()); home.deleteRecursively() }
    }
    @Test fun controlledDeviceLinkIsRejectedBeforeDispatchOrBindingCanTouchOutsideRecords() = runBlocking {
        val target = InstrumentationRegistry.getInstrumentation().targetContext
        val home = File(target.cacheDir, "RootDevice-${UUID.randomUUID()}").canonicalFile.apply { mkdirs() }
        val base = File(home, "NativeBase").apply { mkdir() }; val outside = File(home, "OwnedOutside").apply { mkdir() }
        PersonalStore(File(base, "PaperDigest")).updateSettings(JSONObject().put("offlineMode", true))
        val binding = File(outside, "model-key-binding.json").apply { writeText("outside original synthetic binding") }
        val before = binding.readBytes()
        Files.createSymbolicLink(File(base, "PaperDigestDevice").toPath(), outside.toPath())
        val context = object : ContextWrapper(target) { override fun getNoBackupFilesDir() = base }
        var root: RootController? = null
        try {
            assertTrue(runCatching { RootController(context, installBackground = false).also { root = it } }.isFailure)
            assertArrayEquals(before, binding.readBytes())
            assertEquals(listOf("model-key-binding.json"), outside.list()!!.toList())
        } finally { root?.let { stop(it) }; Files.deleteIfExists(File(base, "PaperDigestDevice").toPath()); home.deleteRecursively() }
    }
    @Test fun fixedCloudChildCannotBeCanonicalizedIntoAnotherProfilesDirectory() = runBlocking {
        val target = InstrumentationRegistry.getInstrumentation().targetContext
        val home = File(target.cacheDir, "RootCloud-${UUID.randomUUID()}").canonicalFile.apply { mkdirs() }
        val base = File(home, "NativeBase").apply { mkdir() }; val outside = File(home, "OwnedOutside").apply { mkdir() }
        PersonalStore(File(base, "PaperDigest")).updateSettings(JSONObject().put("offlineMode", true))
        val profile = File(outside, "profile.json").apply { writeText(JSONObject().put("contract", "paperdigest-android-cloud-profile-v1")
            .put("destinationID", UUID.randomUUID().toString()).put("account", "synthetic-account").put("folder", "PaperDigest")
            .put("automatic", false).put("intervalHours", 24).put("automaticPaused", false).toString()) }
        val before = profile.readBytes()
        Files.createSymbolicLink(File(base, "PaperDigestCloud").toPath(), outside.toPath())
        val context = object : ContextWrapper(target) { override fun getNoBackupFilesDir() = base }
        var root: RootController? = null
        try {
            assertTrue("Actual Root caller must pass the uncanonicalized fixed cloud child to its strict backend", runCatching {
                RootController(context, installBackground = false).also { root = it }
            }.isFailure)
            assertArrayEquals(before, profile.readBytes()); assertEquals(listOf("profile.json"), outside.list()!!.toList())
        } finally { root?.let { stop(it) }; Files.deleteIfExists(File(base, "PaperDigestCloud").toPath()); home.deleteRecursively() }
    }
    private suspend fun stop(root: RootController) {
        val field = root.javaClass.getDeclaredField("exportScope").apply { isAccessible = true }
        val scope = field.get(root) as CoroutineScope; scope.cancel(); scope.coroutineContext[Job]?.join()
    }
}
