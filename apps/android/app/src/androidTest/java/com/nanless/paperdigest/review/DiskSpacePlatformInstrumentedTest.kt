package com.nanless.paperdigest.review

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.nanless.paperdigest.data.*
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID

/** Real Android default filesystem measurement; isolated app cache only, no model/key/remote operation. */
@RunWith(AndroidJUnit4::class)
class DiskSpacePlatformInstrumentedTest {
    private fun root(): File = File(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir,
        "DiskSpacePlatform-${UUID.randomUUID()}").canonicalFile.apply { check(mkdir()) }

    @Test fun captureDefaultProbeSupportsTheActualAndroidPrivateFilesystem() {
        val root = root()
        try {
            val usage = File(root, "ModelUsage").apply { check(mkdir()) }
            val original = File(usage, "original.bin").apply { writeBytes(byteArrayOf(-1, 0, 1)) }
            val capture = HttpResponseCapture.prepare(usage, UUID.randomUUID().toString(), "a".repeat(64), 4096, { "b".repeat(64) })
            val record = JSONObject(capture.manifestFile.readText())
            assertEquals("prepared", record.getString("status")); assertFalse(record.getBoolean("requestIssued"))
            assertEquals(0L, capture.bodyFile.length()); assertTrue(record.isNull("startedAt")); assertTrue(record.isNull("httpStatus"))
            capture.finish("not-issued")
            assertEquals("not-issued", JSONObject(capture.manifestFile.readText()).getString("status"))
            assertArrayEquals(byteArrayOf(-1, 0, 1), original.readBytes())
        } finally { root.deleteRecursively() }
    }

    @Test fun capacityDefaultProbeReturnsRealFiniteAndroidMeasurementWithoutCreatingProofs() {
        val root = root()
        try {
            val research = File(root, "Research").apply { check(mkdir()) }
            val exports = File(root, "Exports").apply { check(mkdir()) }
            val cloud = File(root, "Cloud").apply { check(mkdir()) }
            val device = File(root, "Device").apply { check(mkdir()) }
            val original = File(research, "original.bin").apply { writeBytes(byteArrayOf(-1, 0, 1)) }
            val report = StorageCapacity(research, exports, cloud, device).summary()
            assertTrue(report.getLong("availableBytes") in 1 until Long.MAX_VALUE)
            assertEquals(4, report.getJSONArray("rows").length())
            assertTrue(exports.listFiles()!!.isEmpty()); assertTrue(device.listFiles()!!.isEmpty())
            assertArrayEquals(byteArrayOf(-1, 0, 1), original.readBytes())
        } finally { root.deleteRecursively() }
    }
}
