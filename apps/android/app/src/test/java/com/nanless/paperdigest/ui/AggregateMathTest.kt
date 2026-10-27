package com.nanless.paperdigest.ui

import com.nanless.paperdigest.data.*
import kotlinx.coroutines.*
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** Pure parser/typed-owner regressions. Actual Android KaTeX/WebView remains a separate device check. */
class AggregateMathTest {
    private fun real():JSONObject=JSONObject(requireNotNull(javaClass.getResourceAsStream("/aggregate-math-daily24.json")).bufferedReader().use{it.readText()})
    private fun view():AggregateDocumentView {
        val v=real();val d=v.getJSONObject("descriptor");val s=d.getJSONObject("source")
        val source=AggregateSource(s.getString("manifestSHA256"),s.getString("shardSHA256"),s.getInt("shardBytes"),s.getString("shardURL"),s.getInt("rowIndex"),s.getString("normalizedRowSHA256"),s.getString("normalizedRowAlgorithm"))
        val descriptor=PublishedAggregate(d.getString("id"),d.getString("kind"),null,d.getString("title"),d.getString("titleZh"),d.getString("summary"),d.getString("rawDate"),d.optString("displayDate"),emptyList(),emptyList(),d.getString("sourceURL"),source)
        return AggregateDocumentView(descriptor,v.getString("bodyHTML"),v.getString("rawHTMLSHA256"),v.getString("sanitizedBodySHA256"),v.getInt("rawHTMLBytes"),v.getString("fetchedAt"),emptyList(),emptyList(),true)
    }
    @Test fun realDailyThreePValuesRemainExactOriginalTex(){
        val v=real();assertEquals("c51f3797c5e9036ddb5afef60fab0463c6a2ab48991980639f557d915fe9ab1a",v.getString("rawHTMLSHA256"))
        val original=v.getString("bodyHTML");assertEquals(v.getString("sanitizedBodySHA256"),PublishedAggregateReader.sha(original.toByteArray()))
        val p=ResearchRenderer.prepareHTMLMath(original);for(tex in listOf("p = 0.003","p = 0.009","p = 0.700"))assertTrue(p.formulae.any{it.tex==tex});assertEquals(original,v.getString("bodyHTML"))
    }
    @Test fun codeCurrencyEscapesAreNotInventedAsMath(){
        val p=ResearchRenderer.prepareHTMLMath("<p>\\(x_1\\) 和 \\[x^2\\]</p><pre>\\(code\\)</pre><code>\$raw\$</code><p>价格 \\\$20，单独 \$30</p><p>\\\\(escaped\\)</p>")
        assertEquals(listOf("x_1","x^2"),p.formulae.map{it.tex});assertFalse(p.formulae[0].display);assertTrue(p.formulae[1].display)
    }
    @Test fun existingMathMLAnnotationIsNotParsedTwice(){val p=ResearchRenderer.prepareHTMLMath("<span class='katex'><math><semantics><mi>x</mi><annotation encoding='application/x-tex'>x_1</annotation></semantics></math><span class='katex-html'>duplicate</span></span><math><mi>y</mi></math>");assertEquals(listOf("x_1"),p.formulae.map{it.tex});assertTrue(p.missingAnnotation);assertEquals(1,p.targets.size)}
    @Test fun badTexStaysDataAndBoundsAreEnforced(){val p=ResearchRenderer.prepareHTMLMath("<p>\\(\\unknownCommand{a}\\)</p>");assertEquals("\\unknownCommand{a}",p.formulae.single().tex);assertThrows(IllegalArgumentException::class.java){ResearchRenderer.prepareHTMLMath("<p>"+"\\(x\\) ".repeat(257)+"</p>")}}
    @Test fun typedAggregateWithoutAuthorityUsesOnlyItsBody()=runBlocking{val d=view();val old=d.bodyHTML;var checks=0;val result=ResearchRenderer.renderAggregateBound(d,{checks++}){body->assertEquals(old,body);"<p>local-only-result</p>"};assertEquals(2,checks);assertEquals("<p>local-only-result</p>",result);assertEquals(old,d.bodyHTML);assertEquals("daily",d.descriptor.kind)}
    @Test fun staleOwnerRejectedBeforeRenderer()=runBlocking{var called=false;try{ResearchRenderer.renderAggregateBound(view(),{error("retired")}){called=true;it};fail("Expected owner rejection")}catch(expected:IllegalStateException){};assertFalse(called)}
    @Test fun lateResultCannotAdoptAfterNewDocumentOwner()=runBlocking{val d=view();var owner=true;val started=CompletableDeferred<Unit>();val release=CompletableDeferred<Unit>();val result=async{runCatching{ResearchRenderer.renderAggregateBound(d,{check(owner)}){started.complete(Unit);release.await();"late"}}};started.await();owner=false;release.complete(Unit);assertTrue(result.await().isFailure)}
    @Test fun cancelledRendererCannotAdopt()=runBlocking{val started=CompletableDeferred<Unit>();var published=false;val job=launch{ResearchRenderer.renderAggregateBound(view(),{coroutineContext.ensureActive()}){started.complete(Unit);awaitCancellation()};published=true};started.await();job.cancelAndJoin();assertFalse(published)}
}
