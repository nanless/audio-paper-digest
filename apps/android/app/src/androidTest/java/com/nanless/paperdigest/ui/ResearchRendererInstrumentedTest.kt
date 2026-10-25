package com.nanless.paperdigest.ui

import android.webkit.WebView
import com.nanless.paperdigest.data.Article
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.jsoup.Jsoup
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ResearchRendererInstrumentedTest {
 @Test fun bundledKatexProducesStaticMathMLForSharedExport()=runBlocking {
  val context=InstrumentationRegistry.getInstrumentation().targetContext
  val body=ResearchRenderer.render(context,"# 原始研究\n\n\$x_1\$ 与 \\[\\mathbf{R}=\\frac{1}{N}\\sum_{n=1}^{N}x_nx_n^{\\mathsf{T}}\\]\n\n| 方法 | 得分 |\n|---|---|\n| 基线 | 1 |")
  val doc=Jsoup.parseBodyFragment(body)
  assertEquals(2,doc.select("math").size)
  assertEquals(1,doc.select("table").size)
  assertTrue(doc.select("script,iframe,object,img").isEmpty())
  assertTrue(doc.text().contains("原始研究"))
 }
 @Test fun maliciousModelHtmlCannotExecuteOrFetch()=runBlocking {
  val context=InstrumentationRegistry.getInstrumentation().targetContext
  val body=ResearchRenderer.render(context,"<script>window.PWNED=1</script>\n\n![tracking](https://example.org/x)\n\n\$x+1\$")
  val doc=Jsoup.parseBodyFragment(body)
  assertTrue(doc.select("script,img,iframe").isEmpty())
  assertEquals(1,doc.select("math").size)
  assertTrue(doc.text().contains("window.PWNED"))
 }
 @Test fun unsupportedFormulaReportsFailureRatherThanFakeMath()=runBlocking {
  val context=InstrumentationRegistry.getInstrumentation().targetContext
  var failed=false
  try{ResearchRenderer.render(context,"\\(\\DefinitelyUnsupportedCommand{x}\\)")}catch(_:IllegalArgumentException){failed=true}
  assertTrue(failed)
 }
 @Test fun originalArticleTeXGetsVisualFallbackWithoutChangingOriginal(){runBlocking{
  val context=InstrumentationRegistry.getInstrumentation().targetContext
  val original="<p id='p1'>真实结构</p><math id='eq1' display='block'><semantics><mfrac><mi>x</mi><mi>y</mi></mfrac><annotation encoding='application/x-tex'>\\frac{x}{y}</annotation></semantics></math><table><tr><td>原表</td></tr></table>"
  val article=Article("p1",original,"original text","https://example.org/1","https://example.org/blog","a".repeat(64),"2026-10-25")
  val before=article.json().toString()
  val html=ResearchRenderer.renderArticle(context,article);val doc=Jsoup.parseBodyFragment(html)
  assertEquals(1,doc.select("math").size);assertFalse(doc.select(".katex-html").isEmpty());assertTrue(html.contains("data:font/woff2;base64,"));assertFalse(html.contains("url(fonts/"));assertNotNull(doc.getElementById("eq1"));assertEquals("原表",doc.select("td").text());assertEquals(before,article.json().toString())
 }}
 @Test fun unknownLegacyMathIsPreservedWithHonestCompatibilityNotice(){runBlocking{
  val context=InstrumentationRegistry.getInstrumentation().targetContext
  val article=Article("p1","<math><mi>x</mi></math>","x","https://example.org/1","https://example.org/blog","a".repeat(64),"2026-10-25")
  val html=ResearchRenderer.renderArticle(context,article)
  assertEquals(1,Jsoup.parseBodyFragment(html).select("math").size);assertTrue(html.contains("未携带 TeX"));assertFalse(html.contains("katex-html"))
 }}

 @Test fun restoredHtmlUsesOnlyVerifiedInlineResourceMapAndPreservesCaption(){runBlocking{
  val context=InstrumentationRegistry.getInstrumentation().targetContext
  val sample=org.json.JSONObject(context.assets.open("published/sample.json").bufferedReader().use{it.readText()});val figure=sample.getJSONArray("figures").getJSONObject(0)
  val bytes=context.assets.open("published/"+figure.getString("src")).use{it.readBytes()}
  assertEquals(figure.getString("sha256"),com.nanless.paperdigest.data.sha256(bytes))
  val data="data:"+com.nanless.paperdigest.data.CatalogRepository.imageMime(bytes)+";base64,"+java.util.Base64.getEncoder().encodeToString(bytes)
  val body="<figure id='f1'><img src='https://example.org/verified.png' srcset='https://example.org/unverified.png 2x' alt='original'><figcaption>原图注保留</figcaption></figure>"
  val article=Article("p1",body,"fixture","https://example.org/1","https://example.org/blog","a".repeat(64),"2026-10-25",inlineImages=mapOf("https://example.org/verified.png" to data))
  val before=article.json().toString();val result=Jsoup.parseBodyFragment(ResearchRenderer.renderArticle(context,article))
  assertEquals(data,result.selectFirst("img")!!.attr("src"));assertFalse(result.selectFirst("img")!!.hasAttr("srcset"));assertEquals("原图注保留",result.select("figcaption").text());assertNotNull(result.getElementById("f1"));assertEquals(before,article.json().toString())
 }}
 @Test fun unknownHtmlResourceDoesNotBecomeBlankOrUnexpectedNetwork(){runBlocking{
  val context=InstrumentationRegistry.getInstrumentation().targetContext
  val article=Article("p1","<figure><img src='https://example.org/unknown.png' alt='未核原图'><figcaption>保留图注</figcaption></figure>","fixture","https://example.org/1","https://example.org/blog","a".repeat(64),"2026-10-25")
  val html=ResearchRenderer.renderArticle(context,article);assertTrue(Jsoup.parseBodyFragment(html).select("img").isEmpty());assertTrue(html.contains("图片未核验离线保存"));assertTrue(html.contains("保留图注"))
 }}

 private fun original640PngURI():String {
  // Keep the exact original pixel generator, but retire its large scratch buffers before render begins.
  val pixels=IntArray(640*640);val random=java.util.Random(17);for(i in pixels.indices)pixels[i]=0xff000000.toInt() or random.nextInt(0x1000000)
  val bitmap=android.graphics.Bitmap.createBitmap(pixels,640,640,android.graphics.Bitmap.Config.ARGB_8888)
  return try {val out=java.io.ByteArrayOutputStream();assertTrue(bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG,100,out));"data:image/png;base64,"+java.util.Base64.getEncoder().encodeToString(out.toByteArray())}finally{bitmap.recycle()}
 }
 private fun assertOriginalJson(expected:Any?,actual:Any?,path:String="article"){
  when(expected){
   is org.json.JSONObject->{assertTrue("$path object type",actual is org.json.JSONObject);actual as org.json.JSONObject;val keys=expected.keys().asSequence().toSet();assertEquals("$path exact keys",keys,actual.keys().asSequence().toSet());keys.forEach{assertOriginalJson(expected.get(it),actual.get(it),"$path.$it")}}
   is org.json.JSONArray->{assertTrue("$path array type",actual is org.json.JSONArray);actual as org.json.JSONArray;assertEquals("$path length",expected.length(),actual.length());for(i in 0 until expected.length())assertOriginalJson(expected.get(i),actual.get(i),"$path[$i]")}
   else->assertEquals("$path exact original value",expected,actual)
  }
 }
 /** Inspect the exact trusted renderer output without making a second giant image-attribute object. */
 private fun smallHtmlAfterExactImageCheck(html:String,original:String,marker:String):String {
  assertFalse("Inspection marker must not already exist in original output",html.contains(marker))
  val start=html.indexOf("<img",ignoreCase=true);assertTrue("Actual image element exists",start>=0)
  var cursor=start+4;assertTrue("Actual img tag boundary",cursor<html.length&&(html[cursor].isWhitespace()||html[cursor]=='>'||html[cursor]=='/'))
  var sourceStart=-1;var sourceEnd=-1;var sourceCount=0
  while(cursor<html.length){
   while(cursor<html.length&&html[cursor].isWhitespace())cursor++
   if(cursor>=html.length||html[cursor]=='>'||html[cursor]=='/')break
   val nameStart=cursor;while(cursor<html.length&&(html[cursor].isLetterOrDigit()||html[cursor] in "-_:"))cursor++
   assertTrue("Well-formed actual image attribute",cursor>nameStart);val name=html.substring(nameStart,cursor)
   while(cursor<html.length&&html[cursor].isWhitespace())cursor++
   if(cursor>=html.length||html[cursor]!='=')continue
   cursor++;while(cursor<html.length&&html[cursor].isWhitespace())cursor++
   assertTrue("Renderer image attributes are quoted",cursor<html.length&&(html[cursor]=='\"'||html[cursor]=='\''))
   val quote=html[cursor++];val valueStart=cursor;while(cursor<html.length&&html[cursor]!=quote)cursor++
   assertTrue("Actual image attribute is terminated",cursor<html.length)
   if(name.equals("src",ignoreCase=true)){sourceStart=valueStart;sourceEnd=cursor;sourceCount++}
   cursor++
  }
  assertEquals("One unambiguous actual src attribute",1,sourceCount)
  assertEquals("Original inline image complete length",original.length,sourceEnd-sourceStart)
  assertTrue("Every original inline image character is unchanged",html.regionMatches(sourceStart,original,0,original.length,false))
  return StringBuilder(html.length-(sourceEnd-sourceStart)+marker.length).append(html,0,sourceStart).append(marker).append(html,sourceEnd,html.length).toString()
 }
 @Test fun verifiedLargePngMarkdownRendersSamePixelsWithoutChangingArticle()=runBlocking {
  val context=InstrumentationRegistry.getInstrumentation().targetContext
  val uri=original640PngURI();assertTrue(uri.length>1_000_000)
  val article=Article("p1","","原图文字","https://example.org/1","https://example.org/blog","a".repeat(64),"2026-10-25",markdown="# 原标题\n\n![原图注]($uri)\n\n| 原表 | 数值 |\n|---|---|\n| A | 1 |",inlineImages=mapOf(uri to uri))
  // Deep-owned JSON containers preserve every field; immutable large strings need no second serialized copy.
  val before=article.json();val beforeImages=article.inlineImages.toMap()
  val rendered=ResearchRenderer.renderArticle(context,article);val marker="verified-original-image-"+java.util.UUID.randomUUID();val body=Jsoup.parseBodyFragment(smallHtmlAfterExactImageCheck(rendered,uri,marker));assertEquals(1,body.select("img").size);assertEquals(marker,body.selectFirst("img")!!.attr("src"));assertEquals("原图注",body.selectFirst("img")!!.attr("alt"));assertEquals(1,body.select("table").size)
  assertOriginalJson(before,article.json());assertEquals("Verified original image map is unchanged",beforeImages,article.inlineImages)
 }

}
