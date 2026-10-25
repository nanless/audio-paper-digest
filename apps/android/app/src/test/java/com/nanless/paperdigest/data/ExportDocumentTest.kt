package com.nanless.paperdigest.data

import org.jsoup.Jsoup
import org.junit.Assert.*
import org.junit.Test

class ExportDocumentTest {
    @Test fun originalGuideHeadingMathAndImagesRemainIntactWithoutDuplicateTitle() {
        val body = "<h1>原中文标题</h1><p>说明</p><math><mfrac><mn>1</mn><mn>2</mn></mfrac></math><img src='data:image/png;base64,QUJD' alt='科学图'><table><tr><td>1</td></tr></table>"
        val result = ExportService.htmlDocument("目录标题", body, listOf("原件说明"))
        val parsed = Jsoup.parse(result)
        assertEquals(1, parsed.select("h1").size); assertEquals("原中文标题", parsed.selectFirst("h1")!!.text())
        assertTrue(result.contains(body)); assertEquals(1, parsed.select("mfrac").size); assertEquals(1, parsed.select("img").size); assertEquals(1, parsed.select("table").size)
        assertEquals("目录标题", parsed.title()); assertTrue(parsed.select("[role=note]").text().contains("原件说明"))
    }
    @Test fun headingFreeBodyGetsExactlyOneEscapedDocumentTitle() {
        val result = ExportService.htmlDocument("A < B & C", "<p>真实正文</p>")
        val parsed = Jsoup.parse(result)
        assertEquals(1, parsed.select("h1").size); assertEquals("A < B & C", parsed.select("h1").text()); assertEquals(0, parsed.select("h1 b").size)
    }
    @Test fun literalCodeAndCommentHeadingsDoNotSuppressActualDocumentTitle() {
        val body = "<!-- <h1>不是正文</h1> --><pre><code>&lt;h1&gt;example&lt;/h1&gt;</code></pre>"
        val result = ExportService.htmlDocument("实际标题", body)
        assertEquals("实际标题", Jsoup.parse(result).select("h1").text()); assertTrue(result.contains(body))
    }
}
