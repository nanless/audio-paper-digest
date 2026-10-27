package com.nanless.paperdigest.data

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class PublishedSourceWarningTest {
    private val owner="conference:test:2026:paper:synthetic"
    private val blog="https://nanless.github.io/audio-paper-digest-blog/posts/synthetic-warning/"
    private val source="https://openreview.net/forum?id=synthetic"
    private val warning="  早期预印本，不是 camera-ready。\n<script>只作原文，不执行</script> & 原说明保留。  "
    private fun citation()=JSONObject().put("contract","paper-citation-source-v1").put("verified",true).put("identityStatus","verified").put("paperKey",owner).put("paperId",owner).put("pageUrl",blog).put("sourceUrl",source).put("url",source).put("pdfUrl","").put("sourceKind","conference").put("arxivId","").put("sourceVersionWarning",warning).put("complete",false)
    private fun article(c:JSONObject=citation())=Article(owner,"<p>原导读</p>","原导读",source,blog,"a".repeat(64),"2026-01-01T00:00:00Z",completeOffline=true,notices=listOf("原提示"),citation=c,mathMLContract="published-html-mathml-v1")
    @Test fun completeFalsePreservesWholeText(){assertEquals(listOf("原提示",warning),PublishedSourceWarning.present(article()).notices)}
    @Test fun absentBlankWrongTypeNeverInvented(){for(value in listOf(JSONObject.NULL,false,9,"","  \n ")){val a=article(citation().put("sourceVersionWarning",value));assertEquals(listOf("原提示"),PublishedSourceWarning.present(a).notices)};val c=citation();c.remove("sourceVersionWarning");assertEquals(listOf("原提示"),PublishedSourceWarning.present(article(c)).notices)}
    @Test fun strictVerifiedAndContract(){for((key,value)in listOf("verified" to 1,"verified" to false,"identityStatus" to "unverified","contract" to "future-v1")){assertEquals(listOf("原提示"),PublishedSourceWarning.present(article(citation().put(key,value))).notices)}}
    @Test fun foreignOwnerAliasesRefused(){for(key in listOf("paperKey","paperId")){assertEquals(listOf("原提示"),PublishedSourceWarning.present(article(citation().put(key,"other-owner"))).notices)}}
    @Test fun foreignPageOrSourceRefused(){for(key in listOf("pageUrl","sourceUrl","url")){assertEquals(listOf("原提示"),PublishedSourceWarning.present(article(citation().put(key,"https://example.org/other"))).notices)}}
    @Test fun missingPDFWarningStillVisibleButForeignPDFRefused(){assertEquals(warning,PublishedSourceWarning.warning(article()));assertNull(PublishedSourceWarning.warning(article(citation().put("pdfUrl","https://openreview.net/pdf?id=other"))))}
    @Test fun arxivVersionMustMatchActualMaterial(){val c=citation().put("sourceKind","arxiv").put("paperKey","arxiv:2601.00001").put("paperId","arxiv:2601.00001").put("arxivId","2601.00001v1").put("sourceUrl","https://arxiv.org/abs/2601.00001v1").put("url","https://arxiv.org/abs/2601.00001v1").put("pdfUrl","https://arxiv.org/pdf/2601.00001v1");val a=article(c).copy(paperID="arxiv:2601.00001",sourceURL=c.getString("sourceUrl"),pdfURL=c.getString("pdfUrl"),sourceVersion="2601.00001v1");assertEquals(warning,PublishedSourceWarning.warning(a));c.put("arxivId","2601.00001v2");assertNull(PublishedSourceWarning.warning(a))}
    @Test fun nonArxivBadVersionTypeNotCoerced(){assertNull(PublishedSourceWarning.warning(article(citation().put("arxivId",false))))}
    @Test fun stableDedupKeepsOriginalNoticeOrder(){val a=article().copy(notices=listOf("原提示",warning,"原提示"));assertEquals(listOf("原提示",warning),PublishedSourceWarning.present(a).notices)}
    @Test fun originalArticleAndUnknownFieldsUnchanged(){val c=citation().put("future",JSONObject().put("preserve",true));val a=article(c);val before=a.json().toString();val p=PublishedSourceWarning.present(a);assertEquals(before,a.json().toString());assertEquals(a.html,p.html);assertEquals(a.revisionSHA256,p.revisionSHA256);assertEquals(c.toString(),p.citation.toString());assertEquals("<p>原导读</p>",p.html)}
    @Test fun coldOwnStoredCitationNeverLatestCatalog(){val a=article(citation().put("sourceVersionWarning","旧材料自身警告"));val original=a.json();val before=original.toString();val loaded=Article.fromJson(original);val p=PublishedSourceWarning.present(loaded);assertTrue(p.notices.contains("旧材料自身警告"));assertFalse(p.notices.contains("新版目录警告"));assertEquals(before,original.toString());assertEquals(loaded.revisionSHA256,p.revisionSHA256)}
    @Test fun explicitForeignOfflineArticleDoesNotBorrowPaper(){val a=article().copy(paperID="conference:other");assertEquals(listOf("原提示"),PublishedSourceWarning.present(a).notices)}
    @Test fun actualCatalogParserAddsNoticeWithoutBodyInjection(){val paper=Paper(owner,"合成题目",sourceKind="conference",identityStatus="verified",blogURL=blog,sourceURL=source,citation=citation());val encoded=citation().toString().replace("</","<\\/");val raw="<html><body><div id='article-body' class='post-content'><p>原导读</p></div><script type='application/json' class='paper-tools__citation-record'>"+encoded+"</script></body></html>";val a=CatalogRepository.extractArticle(raw,paper);assertTrue(a.notices.contains(warning));assertTrue(a.plainText.contains("原导读"));assertFalse(a.html.contains("只作原文"))}
    @Test fun ssrnGenericHostRemainsDenied(){assertFalse(CatalogRepository.approvedResource(java.net.URI("https://papers.ssrn.com/sol3/Delivery.cfm/6288899.pdf")))}
}
