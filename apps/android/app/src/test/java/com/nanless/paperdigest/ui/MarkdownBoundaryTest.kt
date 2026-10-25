package com.nanless.paperdigest.ui

import org.commonmark.parser.Parser
import org.commonmark.renderer.html.HtmlRenderer
import org.jsoup.Jsoup
import org.junit.Assert.*
import org.junit.Test

/** Compare with the actual locked CommonMark parser, not an approximation of whether this is an image. */
class MarkdownBoundaryTest {
 private fun originalDOM(markdown:String)=Jsoup.parseBodyFragment(HtmlRenderer.builder().escapeHtml(true).sanitizeUrls(false).build().render(Parser.builder().build().parse(markdown)))
 @Test fun incompleteLargeImageDestinationRemainsLiteralAndCannotShrinkPastTextLimit(){
  val small=validLargePng(1,1);val literal="![原图注]($small";val unchanged=compactVerifiedImageData(literal,mapOf(small to small));assertEquals(literal,unchanged.markdown);assertFalse(unchanged.markdown.contains("paperdigest-offline.invalid"))
  val uri=validLargePng();assertTrue(uri.length>1_000_000);val original="![原图注]($uri"
  val parsed=originalDOM(original);assertTrue(parsed.select("img").isEmpty());assertTrue(parsed.text().contains(uri));assertFalse(parsed.html().contains("paperdigest-offline.invalid"))
  // This is literal original text, not an image: the existing 1M text budget must reject, never invent a placeholder URL.
  assertThrows(IllegalArgumentException::class.java){compactVerifiedImageData(original,mapOf(uri to uri))}
  assertTrue(original.endsWith(uri))
 }
 @Test fun twoBackslashesBeforeVerifiedImagePreserveRealImageAndCaption(){
  val uri=validLargePng();assertTrue(uri.length>1_000_000);val original="\\\\![原图注]($uri)"
  val baseline=originalDOM(original);assertEquals(1,baseline.select("img").size);assertEquals("原图注",baseline.selectFirst("img")!!.attr("alt"));assertEquals(uri,baseline.selectFirst("img")!!.attr("src"))
  val compact=compactVerifiedImageData(original,mapOf(uri to uri));val rendered=Jsoup.parseBodyFragment(ResearchRenderer.prepare(compact.markdown,compact.images).html)
  assertEquals(1,rendered.select("img").size);assertEquals("原图注",rendered.selectFirst("img")!!.attr("alt"));assertEquals(uri,rendered.selectFirst("img")!!.attr("src"));assertFalse(rendered.html().contains("paperdigest-offline.invalid"))
 }
 @Test fun unmatchedInlineBacktickDoesNotHideTheFollowingRealLargeImage(){
  val uri=validLargePng();val original="A dangling ` tick\n\n![原图注]($uri)";val baseline=originalDOM(original)
  assertEquals(1,baseline.select("img").size);assertEquals(uri,baseline.selectFirst("img")!!.attr("src"))
  val compact=compactVerifiedImageData(original,mapOf(uri to uri));val rendered=Jsoup.parseBodyFragment(ResearchRenderer.prepare(compact.markdown,compact.images).html)
  assertEquals(uri,rendered.selectFirst("img")!!.attr("src"));assertEquals("原图注",rendered.selectFirst("img")!!.attr("alt"));assertFalse(rendered.html().contains("paperdigest-offline.invalid"))
 }

}
