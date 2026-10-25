package com.nanless.paperdigest.offline

import android.os.Build
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.nanless.paperdigest.cloud.BackupCodec
import com.nanless.paperdigest.data.*
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.Base64
import java.util.UUID

/** Uses only synthetic assets in a separately named temporary app-private directory. */
@RunWith(AndroidJUnit4::class)
class OfflineStoreDeviceTest {
    @Test fun macPacketsAndFoundationValuesWorkOnActualAndroid() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val fixtureBytes = instrumentation.context.assets.open("offline-swift-vectors.json").use { it.readBytes() }
        val fixtures = JSONObject(fixtureBytes.toString(Charsets.UTF_8))
        val root = File(context.noBackupFilesDir.canonicalFile, "OfflineContractFixture-${UUID.randomUUID()}").apply { check(mkdir()) }
        try {
            fixtures.getJSONArray("foundationVectors").objects().forEach { vector ->
                val raw = vector.getString("inputUTF8").toByteArray(); val expected = vector.getString("expectedUTF8").toByteArray()
                assertArrayEquals(expected, OfflineFoundationJSON.encode(OfflineFoundationJSON.parse(raw)))
            }
            val offline = OfflineStore(root)
            fixtures.getJSONArray("packets").objects().forEach { packet ->
                val folder = File(root, "Offline/${packet.getString("id")}")
                packet.getJSONArray("files").objects().forEach { entry -> BackupCodec.atomicBytes(File(folder, entry.getString("path")), Base64.getDecoder().decode(entry.getString("data"))) }
                val opened = offline.open(packet.getString("id"))
                assertEquals("fixture:paper", opened.paper.id)
                if (packet.optBoolean("hasPDF")) assertEquals(opened.paper.pdfSHA256, BackupCodec.hash(opened.pdfFile!!)) else assertNull(opened.pdfFile)
                if (packet.optBoolean("hasImages")) { assertEquals(1, opened.article.resources.size); assertTrue(opened.article.html.contains("data:image/png;base64,")) }
                if (packet.getBoolean("legacyHTML")) assertTrue(opened.article.notices.any { it.contains("旧离线HTML") })
                packet.getJSONArray("files").objects().forEach { entry -> assertEquals(entry.getString("sha256"), BackupCodec.hash(File(folder, entry.getString("path")))) }
            }
            assertEquals(4, offline.list().count { it.optString("status") == "verified" })
            val original = fixtures.getJSONArray("packets").objects().single { it.optBoolean("hasPDF") && it.optBoolean("hasImages") }
            val files = original.getJSONArray("files").objects().associate { it.getString("path") to Base64.getDecoder().decode(it.getString("data")) }
            val paper = Paper.fromJson(OfflineFoundationJSON.parse(files.getValue("paper.json")))
            val rawArticle = OfflineFoundationJSON.parse(files.getValue("article.json"))
            // Adapt only the newly prepared cache's device-local alias. The
            // original Mac package remains byte-for-byte protected above.
            rawArticle.getJSONArray("resources").objects().forEach { resource -> resource.put("localPath", File(root, "Offline/${original.getString("id")}/resources/${resource.getString("sha256")}.bin").absolutePath) }
            val article = Article.fromJson(rawArticle)
            BackupCodec.atomicBytes(File(root, "PublishedLibrary/articles/${BackupCodec.hash(paper.blogURL.toByteArray())}.json"), OfflineFoundationJSON.encode(rawArticle))
            val originalPDF = File(root, "Offline/${original.getString("id")}/original.pdf")
            val created = offline.register(paper, article, originalPDF)
            assertFalse("Reverse verification must use newly registered Android bytes, not a reused Mac packet", created.getBoolean("reused"))
            assertFalse(fixtures.getJSONArray("packets").objects().any { it.getString("id") == created.getString("id") })
            val newOpened = offline.open(created.getString("id")); assertEquals(paper.pdfSHA256, BackupCodec.hash(newOpened.pdfFile!!)); assertEquals(1, newOpened.article.resources.size); assertTrue(newOpened.article.html.contains("data:image/png;base64,"))
            // A public-only packet can be pulled for the actual Mac verifier;
            // no original user path, account, credential or research is included.
            val folder = File(root, "Offline/${created.getString("id")}")
            val entries = folder.walkTopDown().filter { it.isFile }.map { file ->
                val bytes = file.readBytes(); JSONObject().put("path", file.relativeTo(folder).invariantSeparatorsPath).put("sha256", BackupCodec.hash(bytes)).put("data", Base64.getEncoder().encodeToString(bytes))
            }.toList()
            val report = JSONObject().put("contract", "paperdigest-android-offline-public-device-result-v1").put("sdk", Build.VERSION.SDK_INT)
                .put("fixtureSHA256", BackupCodec.hash(fixtureBytes)).put("source", "Actual Android OfflineStore on synthetic assets only; Mac acceptance still requires external verification")
                .put("packet", JSONObject().put("id", created.getString("id")).put("files", JSONArray(entries))).put("macPacketsOpened", 4).put("foundationVectorsMatched", 2).put("imageCount", 1).put("pdfPages", 1)
            BackupCodec.atomicJSON(File(context.cacheDir.canonicalFile, "offline-contract-result.json"), report)
        } finally { root.deleteRecursively() }
    }
}
