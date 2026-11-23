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
        assertThrows(AppFailure::class.java) { CatalogRepository.imageMime("<svg xmlns='http://www.w3.org/2000/svg' xmlns:s='http://www.w3.org/2000/svg'><s:script>bad()</s:script></svg>".toByteArray()) }
        assertThrows(AppFailure::class.java) { CatalogRepository.imageMime("<svg xmlns='http://www.w3.org/2000/svg'><style>@import 'https://evil.invalid/x.css';</style></svg>".toByteArray()) }
        val malformedUtf8Svg = "<svg>".toByteArray() + byteArrayOf(0xFF.toByte(), 0xFE.toByte()) + "</svg>".toByteArray()
        val badUtf8Err = assertThrows(AppFailure::class.java) { CatalogRepository.imageMime(malformedUtf8Svg) }
        assertEquals("invalid", badUtf8Err.category)
        assertEquals("image/svg+xml", CatalogRepository.imageMime("<svg xmlns='http://www.w3.org/2000/svg'><path d='M0 0'/></svg>".toByteArray()))
    }
    @Test fun ownedPublishedConferenceImagesAndMathMLAndTableAlignmentArePreserved() {
        // E-H7: audio-paper-digest-images parity + case-insensitive host + traversal rejection on externalResourceProxy
        assertTrue(CatalogRepository.approvedResource(java.net.URI("https://RAW.GITHUBUSERCONTENT.COM/nanless/audio-paper-digest-images/main/interspeech-2026/11ff0ce7b961/figure-1.png")))
        assertTrue(CatalogRepository.approvedResource(java.net.URI("https://nanless.github.io/audio-paper-digest-images/icassp-2026/2026-04-29/11462137-0.png")))
        assertFalse(CatalogRepository.approvedResource(java.net.URI("https://raw.githubusercontent.com/nanless/audio-paper-digest-images/main/unknown-2026/11ff0ce7b961/figure-1.png")))
        assertNull(CatalogRepository.externalResourceProxy(java.net.URI("https://raw.githubusercontent.com/nanless/audio-paper-digest-blog/main/../../other/repo/file"), "http://127.0.0.1:7890"))
        assertNull(CatalogRepository.externalResourceProxy(java.net.URI("https://raw.githubusercontent.com/nanless/audio-paper-digest-blog/main/a?x=1"), "http://127.0.0.1:7890"))
        assertEquals("http://127.0.0.1:7890", CatalogRepository.externalResourceProxy(java.net.URI("https://raw.githubusercontent.com/nanless/audio-paper-digest-blog/main/static/x.png"), "http://127.0.0.1:7890"))
        // E-M3 + User Issue #1: 11 MathML tags + presentation attrs, <details open>, Hugo # anchor removal, td/th text-align class preservation
        val paper = CatalogRepository.parsePaper(row())!!
        val html = "<div id='article-body' class='post-content'><h2>标题<a class='anchor' href='#标题'>#</a></h2><details open><summary>展开</summary><p>内容</p></details><math><mstyle displaystyle='true'><mspace width='1em'/><menclose notation='box'><mi>x</mi></menclose></mstyle></math><table><tr><th style='text-align:right'>Score</th><td style='text-align:center'>9.2</td></tr></table></div>"
        val article = CatalogRepository.extractArticle(html, paper)
        assertTrue(article.html.contains("<details open>"))
        assertTrue(article.html.contains("displaystyle=\"true\""))
        assertTrue(article.html.contains("<mspace width=\"1em\""))
        assertTrue(article.html.contains("<menclose notation=\"box\""))
        assertFalse(article.html.contains("class=\"anchor\""))
        assertTrue(article.html.contains("ta-right"))
        assertTrue(article.html.contains("ta-center"))
    }
}
