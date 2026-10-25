package com.nanless.paperdigest.ui

import org.junit.Assert.*
import org.junit.Test

class ResearchRendererTest {
 @Test fun markdownTablesAndLiteralHtmlStaySafe(){val p=ResearchRenderer.prepare("| A | B |\n|---|---|\n| 1 | 2 |\n\n<script>alert(1)</script>");assertTrue(p.html.contains("<table>"));assertFalse(p.html.contains("<script>"));assertTrue(p.html.contains("&lt;script&gt;"))}
 @Test fun fencedAndInlineCodeAreNotMath(){val p=ResearchRenderer.prepare("```tex\n\$\$a+b\$\$\n```\n\n`\$x\$` and \\(x+y\\)");assertEquals(1,p.formulae.size);assertEquals("x+y",p.formulae.single().tex);assertTrue(p.html.contains("<code>"))}
 @Test fun displayAndInlineFormulaePreserveOriginalTex(){val p=ResearchRenderer.prepare("A \$x_1\$ and \$\$\\frac{1}{2}\$\$ plus \\[x^2\\]");assertEquals(3,p.formulae.size);assertFalse(p.formulae[0].display);assertTrue(p.formulae[1].display);assertEquals("\\frac{1}{2}",p.formulae[1].tex)}
 @Test fun unclosedFormulaIsNotInvented(){val p=ResearchRenderer.prepare("A \$unclosed and \\(also");assertTrue(p.formulae.isEmpty())}
 @Test fun networkImagesCannotEscapeOfflineRenderer(){val p=ResearchRenderer.prepare("![sensitive](https://example.org/tracker)");assertFalse(p.html.contains("<img"));assertTrue(p.html.contains("sensitive"))}
 @Test fun javascriptLinkIsSanitized(){val p=ResearchRenderer.prepare("[link](javascript:alert%281%29)");assertFalse(p.html.contains("href=\"javascript:"))}
 @Test fun maximumMathAndInputAreBounded(){assertThrows(IllegalArgumentException::class.java){ResearchRenderer.prepare("\$x\$ ".repeat(257))};assertThrows(IllegalArgumentException::class.java){ResearchRenderer.prepare("x".repeat(1_000_001))}}
 @Test fun maliciousMathRemainsDataBeforeTrustedRenderer(){val p=ResearchRenderer.prepare("\\(</script><script>BAD</script>\\)");assertEquals("</script><script>BAD</script>",p.formulae.single().tex);assertFalse(p.html.contains("BAD"));assertFalse(p.html.contains("<script>"))}
}
