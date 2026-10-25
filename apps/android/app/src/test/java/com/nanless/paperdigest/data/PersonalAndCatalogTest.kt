package com.nanless.paperdigest.data

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.net.InetAddress
import java.nio.file.Files

class PersonalAndCatalogTest {
    private fun store(): PersonalStore = PersonalStore(Files.createTempDirectory("paperdigest-personal-").toRealPath().toFile())
    @Test fun noteConflictPreservesDraftAndStoredVersion() {
        val store = store()
        val first = store.saveNote("paper", "第一版", 0)
        assertEquals(1, first.getInt("revision"))
        assertThrows(AppFailure::class.java) { store.saveNote("paper", "过期草稿", 0) }
        assertEquals("第一版", store.note("paper").getString("text"))
    }
    @Test fun editsKeepUnknownFieldsAndOriginalModelRecords() {
        val store = store(); val original = store.snapshot().put("futureField", JSONObject().put("opaque", "保留"))
        original.getJSONArray("sessions").put(JSONObject().put("id", "old").put("raw", "original"))
        store.replaceValidated(original); store.toggleList("favorites", "paper")
        assertEquals("保留", store.snapshot().getJSONObject("futureField").getString("opaque"))
        assertEquals("original", store.snapshot().getJSONArray("sessions").getJSONObject(0).getString("raw"))
        assertEquals(listOf("paper"), store.list("favorites"))
    }
    @Test fun restartNeverReissuesPendingPaidStudy() {
        val store = store(); store.appendSession(JSONObject().put("id", "old").put("status", "pending").put("requestIssued", true))
        val restored = PersonalStore(store.directory)
        assertEquals("interrupted", restored.session("old")!!.getString("status"))
        assertTrue(restored.session("old")!!.getBoolean("requestIssued"))
        assertEquals("unknown", restored.session("old")!!.getString("charge"))
    }
    @Test fun settingsNeverAcceptSecretOrUnknownCommandFields() {
        val store = store(); store.updateSettings(JSONObject().put("model", "muse-spark-test").put("apiKey", "synthetic-secret").put("jobs", JSONArray()))
        assertEquals("muse-spark-test", store.settings().getString("model"))
        assertFalse(store.settings().has("apiKey")); assertFalse(store.settings().has("jobs"))
    }
    private fun row() = JSONObject().put("pageType", "paper").put("identityStatus", "verified").put("sourceKind", "arxiv").put("arxivId", "2610.27491v1")
        .put("permalink", CatalogRepository.SITE + "posts/micla/").put("title", "MiCLA").put("score", "7.5")
        .put("citation", JSONObject().put("title", "MiCLA").put("arxivId", "2610.27491v1").put("sourceUrl", "https://arxiv.org/abs/2610.27491v1").put("pdfUrl", "https://arxiv.org/pdf/2610.27491v1.pdf"))
    @Test fun scoresAreOnlyDeclaredFiniteNumbers() {
        assertEquals(7.5, CatalogRepository.parsePaper(row())!!.score!!, 0.0)
        listOf(true, "NaN", "Infinity", "12", "mAP=43.2").forEach { assertNull(CatalogRepository.parsePaper(row().put("score", it))!!.score) }
    }
    @Test fun arxivVersionAndUnverifiedPageIdentityAreSeparate() {
        assertEquals("arxiv:2610.27491", CatalogRepository.parsePaper(row())!!.id)
        val unverified = CatalogRepository.parsePaper(row().put("identityStatus", "unverified"))!!
        assertTrue(unverified.id.startsWith("page:")); assertNull(unverified.pdfURL)
    }
    @Test fun pdfHashAliasesMustAgree() {
        val good = "a".repeat(64); val bad = "b".repeat(64)
        assertEquals(good, CatalogRepository.parsePaper(row().put("pdfSha256", good))!!.pdfSHA256)
        assertThrows(IllegalArgumentException::class.java) { CatalogRepository.parsePaper(row().put("pdfSha256", good).put("pdfSHA256", bad)) }
    }
    @Test fun trustedSiteRejectsTraversalCredentialsEncodedAliasAndForeignHost() {
        listOf("https://evil.test/audio-paper-digest-blog/a", "https://u:p@nanless.github.io/audio-paper-digest-blog/a", CatalogRepository.SITE + "%2e%2e/a", CatalogRepository.SITE + "../private", CatalogRepository.SITE + "a?key=x").forEach {
            assertThrows(IllegalArgumentException::class.java) { CatalogRepository.sameSite(it) }
        }
    }
    @Test fun parserPreservesMathTablesAndRemovesExecution() {
        val paper = CatalogRepository.parsePaper(row())!!
        val html = "<div id='article-body' class='post-content'><p onclick='bad()'>真实正文</p><script>evil()</script><math display='block'><mfrac><mi>x</mi><mn>2</mn></mfrac></math><table><tr><td>43.2</td></tr></table><img src='javascript:evil()'></div>"
        val article = CatalogRepository.extractArticle(html, paper)
        assertTrue(article.html.contains("<math")); assertTrue(article.html.contains("<mfrac>")); assertTrue(article.html.contains("<table>"))
        assertFalse(article.html.contains("evil")); assertFalse(article.html.contains("onclick"))
        assertEquals(sha256(article.html.toByteArray()), article.revisionSHA256)
    }
    @Test fun wrongPaperOrVersionNeverBecomesCurrentArticle() {
        val paper = CatalogRepository.parsePaper(row())!!
        val body = "<div id='article-body' class='post-content'>text</div>"
        listOf(JSONObject().put("paperKey", "arxiv:other"), JSONObject().put("paperKey", paper.id).put("arxivId", "2610.27491v2")).forEach {
            val html = "$body<script type='application/json' class='paper-tools__citation-record'>$it</script>"
            assertThrows(IllegalArgumentException::class.java) { CatalogRepository.extractArticle(html, paper) }
        }
        assertThrows(IllegalArgumentException::class.java) { CatalogRepository.extractArticle("<nav>不是正文</nav>", paper) }
    }
    @Test fun resourcePolicyAndDnsBlockPrivateAndUnrelatedRepositories() {
        listOf("127.0.0.1", "10.0.0.1", "100.64.1.2", "169.254.169.254", "192.0.2.1", "198.18.1.1", "203.0.113.2", "::1", "2001:db8::1").forEach { assertFalse(SafeHttp.isPublic(InetAddress.getByName(it))) }
        assertTrue(SafeHttp.isPublic(InetAddress.getByName("8.8.8.8")))
        assertFalse(CatalogRepository.approvedResource(java.net.URI("https://raw.githubusercontent.com/other/repo/main/a.png")))
        assertTrue(CatalogRepository.approvedResource(java.net.URI("https://arxiv.org/pdf/2610.27491v1.pdf")))
    }
    @Test fun scientificImageValidationRejectsActiveSvg() {
        assertEquals("image/png", CatalogRepository.imageMime(byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 1)))
        assertThrows(AppFailure::class.java) { CatalogRepository.imageMime("<svg><script>bad()</script></svg>".toByteArray()) }
        assertEquals("image/svg+xml", CatalogRepository.imageMime("<svg xmlns='http://www.w3.org/2000/svg'><path d='M0 0'/></svg>".toByteArray()))
    }
}
