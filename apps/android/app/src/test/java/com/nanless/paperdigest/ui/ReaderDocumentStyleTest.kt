package com.nanless.paperdigest.ui

import org.junit.Assert.*
import org.junit.Test

class ReaderDocumentStyleTest {
 @Test fun phoneBaselineAndSystemScaleRemainIndependent(){
  assertEquals(100,readerTextZoom(18,1f));assertEquals(200,readerTextZoom(18,2f))
  assertEquals(333,readerTextZoom(30,2f));assertEquals(600,readerTextZoom(54,2f))
  val head=readerDocumentHead(0xfffafafa.toInt(),0xff202020.toInt(),0xff004488.toInt())
  assertTrue(head.contains("font:14px/1.5"));assertTrue(head.contains("padding:0 10px"))
  assertTrue(head.contains("table{display:block;max-width:100%;overflow-x:auto"))
  assertTrue(head.contains("h1{font-size:1.2857em"));assertTrue(head.contains("overflow-wrap:anywhere"))
  assertEquals("All reading CSS blocks must be closed",head.count{it=='{'},head.count{it=='}'})
 }
 @Test fun readingShellGrantsOnlyTheSelectedImageOrigin(){
  val source="https://images.invalid/owned-scope"
  val head=readerDocumentHead(0,0,0,source)
  assertTrue(head.contains("default-src 'none'; img-src $source; font-src data:"))
  assertTrue(head.contains("base-uri 'none'; form-action 'none'"))
  assertFalse(head.contains("script-src"));assertFalse(head.contains("<script"))
 }

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

 @Test
 fun studioMonographDarkMatAndMissingLivePortalClassesAndCtaInkContrast() {
  val lightHead = readerDocumentHead(0xfffaf8f4.toInt(), 0xff1c1a17.toInt(), 0xff0f5c58.toInt())
  val darkHead = readerDocumentHead(0xff121617.toInt(), 0xffede8df.toInt(), 0xff5ecac0.toInt())

  // Studio Monograph CTA ink contrast: light teal -> #ffffff; dark bright teal (#5ecac0, lum > 0.45) -> #141b28
  assertTrue(lightHead.contains("background:#0f5c58;color:#ffffff;"))
  assertTrue(darkHead.contains("background:#5ecac0;color:#141b28;"))

  // Warm archival paper mat for SVGs & transparent PNGs ONLY in dark mode
  assertTrue(darkHead.contains("figure img,p>img{background:#faf8f4;padding:8px;border-radius:10px;"))
  assertFalse(lightHead.contains("figure img,p>img{background:#faf8f4;"))

  // All 9 previously unstyled live portal classes present in both modes
  val portalClasses = listOf(
   ".classification-tree",
   ".classification-cards",
   ".classification-card",
   ".classification-node",
   ".paper-tags",
   ".paper-tags--aggregate",
   ".reader-roadmap-title",
   ".reader-roadmap-list",
   ".audio-spec-quick-header",
   ".audio-spec-quick-title",
   ".audio-demo-cta-wrap",
   ".resource-primary-note",
   ".reader-content-notice",
   ".image-unavailable-notice",
   ".image-original-description",
   ".scoring-weights-strip",
   ".scoring-audit-meta",
   ".math-fallback",
   ".highlight",
   ".chroma",
  )
  for (selector in portalClasses) {
   assertTrue("Missing portal selector in light mode: $selector", lightHead.contains(selector))
   assertTrue("Missing portal selector in dark mode: $selector", darkHead.contains(selector))
  }
  assertEquals(lightHead.count { it == '{' }, lightHead.count { it == '}' })
  assertEquals(darkHead.count { it == '{' }, darkHead.count { it == '}' })
  assertFalse(darkHead.contains("<script"))
  assertFalse(darkHead.contains("script-src"))
  assertFalse(darkHead.contains("media-src"))
 }
}
