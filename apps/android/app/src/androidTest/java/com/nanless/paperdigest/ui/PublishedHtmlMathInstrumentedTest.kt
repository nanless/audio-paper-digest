package com.nanless.paperdigest.ui

import androidx.test.platform.app.InstrumentationRegistry
import com.nanless.paperdigest.data.Article
import com.nanless.paperdigest.data.sha256
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.jsoup.Jsoup
import org.junit.Assert.*
import org.junit.Test

/** Regression uses public bytes exported from the actual API35 online cache, never the bundled seed. */
class PublishedHtmlMathInstrumentedTest {
 @Test fun actualPublishedMiCLAHtmlRendersItsFourOriginalFormulaeWithoutReplacingScientificMaterial()=runBlocking {
  val instrumentation=InstrumentationRegistry.getInstrumentation();val assets=instrumentation.context.assets
  val bytes=assets.open("public-html-math/published-micla-live-11d.html").use{it.readBytes()}
  assertEquals(32573,bytes.size);assertEquals("2fc6a849315312a16fa916ff6e0e8df9728ad596270a9d953894e9e778eeaa4b",sha256(bytes))
  val source=JSONObject(assets.open("public-html-math/published-micla-live-11d-source.json").bufferedReader().use{it.readText()})
  val expected=JSONObject(assets.open("public-html-math/manifest.json").bufferedReader().use{it.readText()}).getJSONObject("mathObservation").getJSONArray("originalDisplayTeX")
  val html=bytes.toString(Charsets.UTF_8);val original=Jsoup.parseBodyFragment(html)
  assertEquals(0,original.select("math").size);assertEquals(4,original.select("table").size);assertEquals(3,original.select("img").size);assertTrue(original.select("img[src]").isEmpty())
  val article=Article(source.getString("paperID"),html,original.text(),"https://arxiv.org/abs/2610.27491v1",source.getString("blogURL"),source.getString("cachedRevision"),source.getString("cachedFetchedAt"),sourceVersion=source.getString("sourceVersion"),completeOffline=false,notices=listOf("公开缓存中的3幅图尚未离线保存"),mathMLContract="published-html-mathml-v1")
  val before=article.json().toString();val body=Jsoup.parseBodyFragment(ResearchRenderer.renderArticle(instrumentation.targetContext,article))
  assertEquals("Four real published TeX expressions must render; do not switch to seed or expect zero",4,body.select("math").size)
  assertEquals((0 until expected.length()).map{expected.getString(it)},body.select("math annotation[encoding=application/x-tex]").map{it.wholeText()})
  assertTrue(body.select("script,iframe,object").isEmpty())
  assertEquals(original.select("table").map{it.outerHtml()},body.select("table").map{it.outerHtml()})
  assertEquals(original.select("figcaption").map{it.text()},body.select("figcaption").map{it.text()})
  assertEquals(original.select("a[href]").map{it.attr("href")},body.select("a[href]").map{it.attr("href")})
  // These are genuinely missing assets: no invented image pixels or unsafe source network loading.
  assertTrue(body.select("img[src]").isEmpty())
  assertEquals(before,article.json().toString());assertEquals("published-html-mathml-v1",article.mathMLContract)
 }
 @Test fun htmlMathOnlyTransformsTextAndKeepsCodeAttributesAndOriginalMathAnnotation()=runBlocking {
  val source="<p id='plain' data-formula='\\(attribute\\)'>Text \\(x+y\\) end.</p><pre>\\[code\\]</pre><code>\$code\$</code><p title='\$title\$'>title stays</p><table data-original='yes'><tr><td>original</td></tr></table><math id='old'><semantics><mi>u</mi><annotation encoding='application/x-tex'>u+v</annotation></semantics></math>"
  val original=Jsoup.parseBodyFragment(source);val article=Article("fixture",source,"fixture","https://example.org/paper","https://example.org/blog","a".repeat(64),"2026-10-25")
  val body=Jsoup.parseBodyFragment(ResearchRenderer.renderArticle(InstrumentationRegistry.getInstrumentation().targetContext,article))
  assertEquals(listOf("x+y","u+v"),body.select("math annotation").map{it.wholeText()});assertNotNull(body.getElementById("old"));assertEquals(original.select("pre,code").map{it.outerHtml()},body.select("pre,code").map{it.outerHtml()});assertEquals(original.getElementById("plain")!!.attr("data-formula"),body.getElementById("plain")!!.attr("data-formula"));assertEquals(original.select("[title]").attr("title"),body.select("[title]").attr("title"));assertEquals(original.select("table").outerHtml(),body.select("table").outerHtml())
 }
 @Test fun unrenderedLegacyKatexClassDoesNotHideOriginalTextFormula()=runBlocking {
  val html="<div class='katex-display'>\\[x\\]</div>";val article=Article("fixture",html,"x","https://example.org/paper","https://example.org/blog","a".repeat(64),"2026-10-25")
  val before=article.json().toString();val result=Jsoup.parseBodyFragment(ResearchRenderer.renderArticle(InstrumentationRegistry.getInstrumentation().targetContext,article))
  assertEquals(listOf("x"),result.select("math annotation[encoding=application/x-tex]").map{it.wholeText()});assertEquals("block",result.selectFirst("math")!!.attr("display"));assertEquals(before,article.json().toString())
 }

}
