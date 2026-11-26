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
        val webpUtf8Shift = "RIFF".toByteArray(Charsets.US_ASCII) + byteArrayOf(0xC2.toByte(), 0xA0.toByte(), 0x00, 0x00) + "WEBP".toByteArray(Charsets.US_ASCII) + byteArrayOf(0x56, 0x50, 0x38, 0x20)
        assertEquals("image/webp", CatalogRepository.imageMime(webpUtf8Shift))
        val webpNonUtf8 = "RIFF".toByteArray(Charsets.US_ASCII) + byteArrayOf(0xFF.toByte(), 0xFE.toByte(), 0x80.toByte(), 0x81.toByte()) + "WEBP".toByteArray(Charsets.US_ASCII)
        assertEquals("image/webp", CatalogRepository.imageMime(webpNonUtf8))
        val gifBinary = "GIF89a".toByteArray(Charsets.US_ASCII) + byteArrayOf(0xFF.toByte(), 0xFE.toByte())
        assertEquals("image/gif", CatalogRepository.imageMime(gifBinary))
        assertThrows(AppFailure::class.java) { CatalogRepository.imageMime("<svg><script>bad()</script></svg>".toByteArray()) }
        assertThrows(AppFailure::class.java) { CatalogRepository.imageMime("<svg xmlns='http://www.w3.org/2000/svg' xmlns:s='http://www.w3.org/2000/svg'><s:script>bad()</s:script></svg>".toByteArray()) }
        assertThrows(AppFailure::class.java) { CatalogRepository.imageMime("<svg xmlns='http://www.w3.org/2000/svg'><style>@import 'https://evil.invalid/x.css';</style></svg>".toByteArray()) }
        val malformedUtf8Svg = "<svg>".toByteArray() + byteArrayOf(0xFF.toByte(), 0xFE.toByte()) + "</svg>".toByteArray()
        val badUtf8Err = assertThrows(AppFailure::class.java) { CatalogRepository.imageMime(malformedUtf8Svg) }
        assertEquals("invalid", badUtf8Err.category)
        assertEquals("image/svg+xml", CatalogRepository.imageMime("<svg xmlns='http://www.w3.org/2000/svg'><path d='M0 0'/></svg>".toByteArray()))
    }
    @Test fun ownedPublishedConferenceImagesAndMathMLAndTableAlignmentArePreserved() {
        // E-H7 + CL-P2-8: audio-paper-digest-images parity + zenodo.org + case-insensitive host + traversal rejection on externalResourceProxy
        assertTrue(CatalogRepository.approvedResource(java.net.URI("https://RAW.GITHUBUSERCONTENT.COM/nanless/audio-paper-digest-images/main/interspeech-2026/11ff0ce7b961/figure-1.png")))
        for (slug in listOf("icml-2026", "emnlp-2026", "ismir-2026", "dcase-2026", "neurips-2026", "waspaa-2025", "asru-2025")) {
            assertTrue("expected conference slug allowed: $slug", CatalogRepository.approvedResource(java.net.URI("https://raw.githubusercontent.com/nanless/audio-paper-digest-images/main/$slug/0123456789ab/figure-1.png")))
        }
        assertTrue(CatalogRepository.approvedResource(java.net.URI("https://zenodo.org/records/1234567/files/paper.pdf")))
        assertTrue("zenodo.org" in SafeHttp.APPROVED_SYNTHETIC_HOSTS)
        val conferenceOfficialPDFs = listOf(
            "https://ojs.aaai.org/index.php/AAAI/article/view/35001/37200" to "ojs.aaai.org",
            "https://openaccess.thecvf.com/content/CVPR2026/papers/Author_Paper_CVPR_2026_paper.pdf" to "openaccess.thecvf.com",
            "https://eurasip.org/Proceedings/Eusipco/Eusipco2026/pdfs/1571000001.pdf" to "eurasip.org",
            "https://www.eurasip.org/Proceedings/Eusipco/Eusipco2026/pdfs/1571000001.pdf" to "www.eurasip.org",
            "https://nime.org/proceedings/2026/nime2026_12.pdf" to "nime.org",
            "https://www.nime.org/proceedings/2026/nime2026_12.pdf" to "www.nime.org",
            "https://dafx26.mit.edu/assets/papers/DAFx26_paper_42.pdf" to "dafx26.mit.edu",
            "https://icmc2026.ligeti-zentrum.de/wp-content/uploads/2026/07/ICMC2026_proceedings_V2showcase.pdf" to "icmc2026.ligeti-zentrum.de",
        )
        for ((pdfUrl, host) in conferenceOfficialPDFs) {
            assertTrue("expected official conference PDF allowed: $pdfUrl", CatalogRepository.approvedResource(java.net.URI(pdfUrl)))
            assertTrue("expected official conference host in synthetic allowlist: $host", host in SafeHttp.APPROVED_SYNTHETIC_HOSTS)
        }
        val untrustedConferenceUrls = listOf(
            "http://ojs.aaai.org/index.php/AAAI/article/view/35001/37200",
            "https://ojs.aaai.org.evil.invalid/paper.pdf",
            "https://openaccess.thecvf.com:8443/content/CVPR2026/papers/paper.pdf",
            "https://user@dafx26.mit.edu/assets/papers/DAFx26_paper_1.pdf",
            "https://evil-eurasip.org/Proceedings/Eusipco/Eusipco2026/pdfs/1.pdf",
            "https://evil.nime.org/proceedings/2026/nime2026_1.pdf",
            "https://icmc2026.ligeti-zentrum.de.evil.invalid/paper.pdf",
            "https://untrusted.example.org/proceedings/paper.pdf",
        )
        for (badUrl in untrustedConferenceUrls) {
            assertFalse("expected untrusted URL rejected: $badUrl", CatalogRepository.approvedResource(java.net.URI(badUrl)))
        }
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
    @Test fun officialIclrAndMlresearchProceedingsPdfsAnd64ImageCap() {
        assertTrue(CatalogRepository.approvedResource(java.net.URI("https://proceedings.iclr.cc/paper_files/paper/2026/file/abc123.pdf")))
        assertTrue("proceedings.iclr.cc" in SafeHttp.APPROVED_SYNTHETIC_HOSTS)

        val validMlresearch = "https://raw.githubusercontent.com/mlresearch/v267/main/assets/smith25a/smith25a.pdf"
        assertTrue(CatalogRepository.isApprovedOfficialProceedingsPdf(java.net.URI(validMlresearch)))
        assertTrue(CatalogRepository.approvedResource(java.net.URI(validMlresearch)))
        assertEquals("http://127.0.0.1:7890", CatalogRepository.externalResourceProxy(java.net.URI(validMlresearch), "http://127.0.0.1:7890"))

        val invalidMlresearch = listOf(
            "http://raw.githubusercontent.com/mlresearch/v267/main/assets/smith25a/smith25a.pdf",
            "https://user@raw.githubusercontent.com/mlresearch/v267/main/assets/smith25a/smith25a.pdf",
            "https://raw.githubusercontent.com:8443/mlresearch/v267/main/assets/smith25a/smith25a.pdf",
            "https://raw.githubusercontent.com/mlresearch/v267/main/assets/smith25a/smith25a.pdf?raw=1",
            "https://raw.githubusercontent.com/mlresearch/v267/main/assets/smith25a/smith25a.pdf#page=1",
            "https://raw.githubusercontent.com/mlresearch/v267/main/assets/smith25a/..%2fsecret.pdf",
            "https://raw.githubusercontent.com/mlresearch/v267/main/assets/../other/paper.pdf",
            "https://raw.githubusercontent.com/mlresearch/v267/main/assets/./paper.pdf",
            "https://raw.githubusercontent.com/mlresearch/v267/main//assets/smith25a/smith25a.pdf",
            "https://raw.githubusercontent.com/mlresearch/v267/main/assets/smith25a/smith25a.png",
            "https://raw.githubusercontent.com/otherorg/v267/main/assets/smith25a/smith25a.pdf",
            "https://raw.githubusercontent.com/mlresearch/v267/main/assets/smith25a/sub/smith25a.pdf",
        )
        for (bad in invalidMlresearch) {
            val uri = java.net.URI(bad)
            assertFalse("must reject mlresearch url: $bad", CatalogRepository.isApprovedOfficialProceedingsPdf(uri))
            assertFalse("must reject approvedResource: $bad", CatalogRepository.approvedResource(uri))
            assertNull("must not proxy rejected mlresearch url: $bad", CatalogRepository.externalResourceProxy(uri, "http://127.0.0.1:7890"))
        }

        val paper = CatalogRepository.parsePaper(row())!!
        fun htmlWithImages(count: Int) = "<div id='article-body' class='post-content'>" +
            (1..count).joinToString("") { i -> "<img src='https://arxiv.org/html/2610.27491v1/x$i.png' alt='fig $i'/>" } +
            "</div>"
        assertEquals(36, org.jsoup.Jsoup.parseBodyFragment(CatalogRepository.extractArticle(htmlWithImages(36), paper).html).select("img").size)
        assertEquals(64, org.jsoup.Jsoup.parseBodyFragment(CatalogRepository.extractArticle(htmlWithImages(64), paper).html).select("img").size)
        assertThrows(IllegalArgumentException::class.java) { CatalogRepository.extractArticle(htmlWithImages(65), paper) }
    }
}
