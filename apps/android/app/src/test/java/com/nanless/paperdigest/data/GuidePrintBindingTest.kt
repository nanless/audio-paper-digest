package com.nanless.paperdigest.data

import org.junit.Assert.*
import org.junit.Test

class GuidePrintBindingTest {
    private val paper=Paper("review-print","原论文",blogURL="https://example.test/article/",sourceURL="https://example.test/source/v1",pdfURL="https://example.test/source/v1.pdf",sourceVersion="v1")
    private val article=Article(paperID=paper.id,html="<p>原文</p>",plainText="原文",revisionSHA256="a".repeat(64),fetchedAt="2026-10-25T07:00:00Z",blogURL=paper.blogURL,sourceURL=paper.sourceURL!!,sourceVersion=paper.sourceVersion,pdfURL=paper.pdfURL)
    @Test fun sameReadingKeepsOriginalArticleNotLatestCatalog() {
        val original=GuidePrintReading("original-token",paper,article)
        val binding=GuidePrintBinding(paper,article,"original-token"){original}
        binding.requireCurrent();assertSame(article,binding.article)
    }
    @Test fun noMaterialIdOrWrongArticleCannotPrepare() {
        assertThrows(IllegalArgumentException::class.java){GuidePrintBinding(paper,article,""){GuidePrintReading("",paper,article)}}
        assertThrows(IllegalArgumentException::class.java){GuidePrintBinding(paper,article.copy(sourceVersion="v2"),"a"){GuidePrintReading("a",paper,article)}}
    }
    @Test fun switchDuringRenderIsRejectedBeforeSystemHandoff() {
        var now=GuidePrintReading("a",paper,article);val binding=GuidePrintBinding(paper,article,"a"){now};binding.requireCurrent()
        now=GuidePrintReading("b",paper.copy(id="different"),null)
        assertThrows(IllegalArgumentException::class.java){binding.requireCurrent()}
    }
    @Test fun samePaperNewRevisionAndLostCurrentArticleAreRejected() {
        var now=GuidePrintReading("a",paper,article);val binding=GuidePrintBinding(paper,article,"a"){now}
        now=now.copy(article=article.copy(revisionSHA256="b".repeat(64)))
        assertThrows(IllegalArgumentException::class.java){binding.requireCurrent()}
        now=now.copy(article=null);assertThrows(IllegalArgumentException::class.java){binding.requireCurrent()}
    }
}
