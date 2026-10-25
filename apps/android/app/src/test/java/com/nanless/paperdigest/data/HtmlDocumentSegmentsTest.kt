package com.nanless.paperdigest.data

import org.jsoup.Jsoup
import org.junit.Assert.*
import org.junit.Test

class HtmlDocumentSegmentsTest {
    private fun legacy(title: String, body: String, notices: List<String>): String {
        val hasTitle = title.isNotBlank() && Jsoup.parseBodyFragment(body).body().select("h1").any { it.text().isNotBlank() }
        val heading = if (title.isBlank() || hasTitle) "" else "<h1>${ExportService.escape(title)}</h1>"
        return ExportService.htmlDocumentHead(title) + heading + notices.joinToString("") { "<p role='note'>${ExportService.escape(it)}</p>" } + body + "</body></html>"
    }
    @Test fun streamMatchesOriginalExportTitleNoticesUnicodeAndSplitReadBytes() {
        val body = "<article><h2>原表 😀</h2><table><tr><td>⻑𠀀</td></tr></table><math><mi>α</mi></math></article>"
        val notices = listOf("版本 <v1> & 未知", "保留原提示")
        val parts = HtmlDocumentSegments.create("标题 <&> 😀", body, notices)
        assertSame(body, parts.body)
        val expected = legacy("标题 <&> 😀", body, notices).toByteArray(Charsets.UTF_8)
        for (chunk in listOf(1, 3, 31, 65536)) {
            val out = java.io.ByteArrayOutputStream()
            parts.asStreamedDocument().openStream().use { input -> val buffer = ByteArray(chunk); while (true) { val n=input.read(buffer); if(n<0)break;out.write(buffer,0,n) } }
            assertArrayEquals(expected, out.toByteArray())
        }
        assertEquals(legacy("标题 <&> 😀", body, notices), parts.joinForExport())
    }
    @Test fun actualH1SemanticsArePreservedWithoutCommentOrEmptyHeadingGuess() {
        for(body in listOf("<!-- <h1>假</h1> --><p>正文</p>","<h1> </h1><p>正文</p>","<h1><span>真实题名</span></h1>","<h10>不是h1</h10>")) {
            assertEquals(legacy("原题",body,listOf("原提示")), HtmlDocumentSegments.create("原题",body,listOf("原提示")).joinForExport())
        }
    }
    @Test fun exactDocumentMainGetOnlyNoCrossDocumentPostSubframeQueryOrSuffix() {
        val document=HtmlDocumentSegments.create("题","<p>正文</p>").asStreamedDocument()
        assertTrue(document.canServe(document.url,true,"GET"))
        assertFalse(document.canServe(document.url,false,"GET"));assertFalse(document.canServe(document.url,true,"POST"))
        assertFalse(document.canServe(document.url+"?x=1",true,"GET"));assertFalse(document.canServe(document.url+"/suffix",true,"GET"))
        assertFalse(document.canServe(HtmlDocumentSegments.create("题","<p>正文</p>").asStreamedDocument().url,true,"GET"))
    }
    @Test fun originalPublishedScientificBodyAndEveryImageSourceRemainExact() {
        val fixture=listOf(java.io.File("build/generated/published-assets/debug/published/article.html"),java.io.File("app/build/generated/published-assets/debug/published/article.html")).firstOrNull{it.isFile}
        requireNotNull(fixture) { "verified public generated article fixture is required; no substitute body" }
        val input=fixture.readText()
        val original=Jsoup.parse(input).body().html()
        val parts=HtmlDocumentSegments.create("MiCLA",original,listOf("明确原版本提示"))
        assertSame(original,parts.body)
        val actual=parts.asStreamedDocument().openStream().use{it.readBytes()}.toString(Charsets.UTF_8)
        assertEquals(legacy("MiCLA",original,listOf("明确原版本提示")),actual)
        val before=Jsoup.parseBodyFragment(original);val after=Jsoup.parse(actual)
        assertEquals(3,before.select("img").size);assertEquals(4,before.select("math").size);assertEquals(4,before.select("table").size)
        for(selector in listOf("img","math","table"))assertEquals(before.select(selector).map{it.outerHtml()},after.select(selector).map{it.outerHtml()})
    }
}
