package com.nanless.paperdigest.pdf
import org.junit.Assert.*
import org.junit.Test

class PdfTextSemanticsTest {
    private val sha="a".repeat(64)
    private val page=PdfPageText(5,"Alpha beta ALPHA",100f,100f,listOf(PdfTextSpan(0,5,PdfSelectionBounds(5,1f,2f,30f,12f)),PdfTextSpan(6,10,PdfSelectionBounds(5,40f,2f,60f,12f)),PdfTextSpan(11,16,PdfSelectionBounds(5,1f,15f,30f,25f))))
    @Test fun selectionKeepsExactOriginalTextPhysicalPageAndCoordinates(){val s=PdfTextSemantics.selection(sha,page,0,5);assertEquals("Alpha",s.text);assertEquals(listOf(5),s.pages);assertEquals(sha,s.documentSHA256);assertEquals(listOf(page.spans.first().bounds),s.bounds)}
    @Test fun partialSelectionNeverInventsAnExactNewGlyphRectangle(){val s=PdfTextSemantics.selection(sha,page,1,4);assertEquals("lph",s.text);assertEquals(listOf(page.spans.first().bounds),s.bounds)}
    @Test fun missingGeometryRemainsMissingInsteadOfFabricated(){assertTrue(PdfTextSemantics.selection(sha,page.copy(spans=emptyList()),0,5).bounds.isEmpty())}
    @Test fun findIsCaseInsensitiveAndKeepsTwoRealRanges(){val results=PdfTextSemantics.search(listOf(page),"alpha");assertEquals(listOf(0,11),results.map{it.start});assertEquals(listOf("Alpha","ALPHA"),results.map{it.text});assertTrue(results.all{it.page==5&&it.bounds.size==1})}
    @Test fun noMatchIsAnActualEmptyResult(){assertTrue(PdfTextSemantics.search(listOf(page),"gamma").isEmpty())}
    @Test fun reversedEmptyAndOutOfPageRangesAreRejected(){for(range in listOf(-1 to 3,5 to 3,0 to 17,3 to 3)){assertThrows(IllegalArgumentException::class.java){PdfTextSemantics.selection(sha,page,range.first,range.second)}}}
    @Test fun blankSelectionAndInvalidSourceAreRejected(){assertThrows(IllegalArgumentException::class.java){PdfTextSemantics.selection(sha,page,5,6)};assertThrows(IllegalArgumentException::class.java){PdfTextSemantics.selection("bad",page,0,5)}}
    @Test fun blankOrExcessiveSearchDoesNotRun(){for(query in listOf(" ","a".repeat(1001))){assertThrows(IllegalArgumentException::class.java){PdfTextSemantics.search(listOf(page),query)}}}
    @Test fun excessiveMatchesAreAnExplicitFailureRatherThanPartialResults(){assertThrows(IllegalArgumentException::class.java){PdfTextSemantics.search(listOf(page.copy(text="a".repeat(10001),spans=emptyList())),"a")};assertEquals(10000,PdfTextSemantics.search(listOf(page.copy(text="a".repeat(10000),spans=emptyList())),"a").size)}
}
