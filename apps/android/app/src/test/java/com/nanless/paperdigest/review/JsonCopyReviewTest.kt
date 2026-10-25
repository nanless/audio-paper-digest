package com.nanless.paperdigest.review

import com.nanless.paperdigest.data.Article
import com.nanless.paperdigest.data.JsonFiles
import com.nanless.paperdigest.data.Paper
import com.nanless.paperdigest.data.canonical
import com.nanless.paperdigest.data.copy
import kotlinx.coroutines.CancellationException
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.math.BigDecimal
import java.math.BigInteger
import java.nio.file.Files

/** Non-author probes of mutable JSON boundaries; all sealed material below is synthetic. */
class JsonCopyReviewTest {
    @Test fun nestedContainersAreIsolatedInBothDirectionsAndUnknownFieldsSurvive() {
        val source = JSONObject("""{"unknown":{"nested":[{"answer":"original","nothing":null},[1,2]]},"question":"synthetic"}""")
        val original = canonical(source)
        val copied = source.copy()
        assertEquals(original, canonical(copied))
        copied.getJSONObject("unknown").getJSONArray("nested").getJSONObject(0).put("answer", "copy edit")
        copied.getJSONObject("unknown").getJSONArray("nested").getJSONArray(1).put(0, 99)
        assertEquals(original, canonical(source))
        source.getJSONObject("unknown").put("futureField", JSONObject().put("kept", true))
        assertFalse(copied.getJSONObject("unknown").has("futureField"))
        assertTrue(copied.getJSONObject("unknown").getJSONArray("nested").getJSONObject(0).isNull("nothing"))
    }

    @Test fun sharedChildIsNotACycleAndEachExportOwnsItsContainers() {
        val child = JSONObject().put("value", JSONArray().put("original"))
        val source = JSONObject().put("left", child).put("right", child)
        val copied = source.copy()
        copied.getJSONObject("left").getJSONArray("value").put(0, "changed")
        assertEquals("original", copied.getJSONObject("right").getJSONArray("value").getString(0))
        assertEquals("original", child.getJSONArray("value").getString(0))
    }

    @Test fun finiteFloatNegativeZeroAndLargeNumbersKeepCanonicalFacts() {
        val source = JSONObject().put("float", 0.1f).put("tiny", Float.MIN_VALUE).put("max", Float.MAX_VALUE)
            .put("negativeZero", -0.0).put("integer", Long.MAX_VALUE)
            .put("bigInteger", BigInteger("123456789012345678901234567890"))
            .put("decimal", BigDecimal("0.123456789012345678900"))
        val before = canonical(source)
        val copied = source.copy()
        assertEquals(before, canonical(copied))
        assertEquals(Long.MAX_VALUE, copied.getLong("integer"))
        assertEquals(source.get("bigInteger").toString(), copied.get("bigInteger").toString())
        assertEquals(source.get("decimal").toString(), copied.get("decimal").toString())
        assertEquals(java.lang.Double.doubleToRawLongBits(-0.0), java.lang.Double.doubleToRawLongBits(copied.getDouble("negativeZero")))
        assertEquals("Scalar copying must not invent higher precision provider facts", source.get("float"), copied.get("float"))
    }

    @Test fun cycleDepthAndNonJsonObjectsFailWithoutMutatingOriginals() {
        val cyclic = JSONObject().put("untouched", "original"); cyclic.put("self", cyclic)
        assertTrue(runCatching { cyclic.copy() }.exceptionOrNull() is IllegalArgumentException)
        assertSame(cyclic, cyclic.get("self")); assertEquals("original", cyclic.getString("untouched"))
        val unsupported = JSONObject().put("answer", "original").put("unexpected", Any())
        assertTrue(runCatching { unsupported.copy() }.exceptionOrNull() is IllegalArgumentException)
        assertEquals("original", unsupported.getString("answer"))
        val deep = JSONObject(); var cursor = deep
        repeat(129) { val child = JSONObject(); cursor.put("child", child); cursor = child }
        cursor.put("answer", "original")
        assertTrue(runCatching { deep.copy() }.exceptionOrNull() is IllegalArgumentException)
        assertEquals("original", cursor.getString("answer"))
        assertEquals("valid", JSONObject().put("answer", "valid").copy().getString("answer"))
    }

    @Test fun publicPaperImportAndExportCannotMutateEachOthersCitationOrUnknownFields() {
        val source = JSONObject().put("id", "fixture:copy").put("title", "Synthetic paper")
            .put("citation", JSONObject().put("title", "Original citation"))
            .put("unknown", JSONObject().put("raw", JSONArray().put("original")))
        val paper = Paper.fromJson(source)
        source.getJSONObject("citation").put("title", "input edit")
        source.getJSONObject("unknown").getJSONArray("raw").put(0, "input edit")
        assertEquals("Original citation", paper.json().getJSONObject("citation").getString("title"))
        assertEquals("original", paper.json().getJSONObject("unknown").getJSONArray("raw").getString(0))
        val exported = paper.json()
        exported.getJSONObject("citation").put("title", "export edit")
        exported.getJSONObject("unknown").getJSONArray("raw").put(0, "export edit")
        assertEquals("Original citation", paper.json().getJSONObject("citation").getString("title"))
        assertEquals("original", paper.json().getJSONObject("unknown").getJSONArray("raw").getString(0))
    }

    @Test fun articlePublicRoundTripDoesNotAliasCitationOrResearchContext() {
        val source = JSONObject().put("paperID", "fixture:copy").put("html", "<p>Original</p>").put("plainText", "Original")
            .put("sourceURL", "https://example.invalid/original").put("blogURL", "https://example.invalid/guide")
            .put("revisionSHA256", "a".repeat(64)).put("fetchedAt", "2026-01-01T00:00:00Z")
            .put("citation", JSONObject().put("title", "Original citation")).put("researchContext", JSONObject().put("evidence", "original"))
        val article = Article.fromJson(source)
        source.getJSONObject("citation").put("title", "input edit")
        source.getJSONObject("researchContext").put("evidence", "input edit")
        assertEquals("Original citation", article.json().getJSONObject("citation").getString("title"))
        assertEquals("original", article.json().getJSONObject("researchContext").getString("evidence"))
        val exported = article.json()
        exported.getJSONObject("citation").put("title", "export edit")
        exported.getJSONObject("researchContext").put("evidence", "export edit")
        assertEquals("Original citation", article.json().getJSONObject("citation").getString("title"))
        assertEquals("original", article.json().getJSONObject("researchContext").getString("evidence"))
    }

    @Test fun boundedStreamingFailureAndCancellationPreserveExactOriginalBytes() {
        val root = Files.createTempDirectory("stream-copy-review-").toRealPath().toFile()
        try {
            val file = java.io.File(root, "current.json")
            val original = "{ \"syntheticSealed\" : [1, 2], \"float\":1.00 }\n".toByteArray()
            file.writeBytes(original)
            assertNotNull(runCatching { JsonFiles.writeStream(file, 3) { it.write("1234".toByteArray()) } }.exceptionOrNull())
            assertArrayEquals(original, file.readBytes())
            val cancelled = runCatching { JsonFiles.writeStream(file, 4096) { it.write("partial".toByteArray()); throw CancellationException("synthetic cancellation") } }.exceptionOrNull()
            assertTrue(cancelled is CancellationException)
            assertArrayEquals(original, file.readBytes())
            assertEquals(listOf("current.json"), root.listFiles()!!.map { it.name })
            JsonFiles.writeStream(file, 2) { it.write("é".toByteArray(Charsets.UTF_8)) }
            assertEquals("é", file.readText())
            assertEquals(2L, file.length())
        } finally { root.deleteRecursively() }
    }
}
