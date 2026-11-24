package com.nanless.paperdigest.ui

import org.junit.Assert.*
import org.junit.Test

class ReaderDocumentStyleV15Test {
    @Test
    fun wave12AndTrack133CssPresentWithIntactCspAndBalancedBraces() {
        val head = readerDocumentHead(0xfffafafa.toInt(), 0xff202020.toInt(), 0xff004488.toInt())
        val requiredSelectors = listOf(
            ".audio-spec-quick-card",
            ".audio-spec-grid",
            "a.audio-demo-cta-btn",
            ".implementation-specs-card",
            ".digest-brief-card",
            ".digest-reading-tiers",
            ".digest-spotlight-card",
            "details.compact-authors-details",
            "details.index-abstract-more",
            ".scoring-audit-card",
            ".scoring-evidence-grid",
            ".scoring-strengths-box",
            ".scoring-defects-box",
        )
        requiredSelectors.forEach { selector ->
            assertTrue("Missing Wave 12 / Track 13.3 selector: $selector", head.contains(selector))
        }
        // Strict WebView CSP & syntax integrity checks
        assertTrue(head.contains("default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"))
        assertFalse(head.contains("media-src"))
        assertFalse(head.contains("script-src"))
        assertFalse(head.contains("<script"))
        assertEquals("All CSS blocks must be balanced", head.count { it == '{' }, head.count { it == '}' })
        // P2 #16: Light-mode dark link uses white foreground on CTA button
        assertTrue(head.contains("a.audio-demo-cta-btn{display:inline-flex;align-items:center;gap:6px;margin:.35em .35em .2em 0;padding:6px 12px;border-radius:999px;background:#004488;color:#ffffff;"))
    }

    @Test
    fun darkModeLightLinkUsesDarkForegroundOnAudioDemoCtaButton() {
        val darkHead = readerDocumentHead(0xff121418.toInt(), 0xffedf1f7.toInt(), 0xffa8c7ff.toInt())
        assertTrue(
            "Dark-mode light accent link must use high-contrast dark foreground on CTA button",
            darkHead.contains("a.audio-demo-cta-btn{display:inline-flex;align-items:center;gap:6px;margin:.35em .35em .2em 0;padding:6px 12px;border-radius:999px;background:#a8c7ff;color:#141b28;")
        )
        assertEquals(darkHead.count { it == '{' }, darkHead.count { it == '}' })
    }
}
