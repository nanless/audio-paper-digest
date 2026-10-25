package com.nanless.paperdigest.pdf
import org.junit.Assert.*
import org.junit.Test
class PdfOutputPagesTest {
 @Test fun pageRangeIsZeroBasedInclusiveAndUnionHasNoDuplicatedPages(){assertEquals(listOf(0,1,2,3,7),PdfOutputPages.resolve(13,listOf(PdfOutputRange(1,3),PdfOutputRange(0,1),PdfOutputRange(7,7))))}
 @Test fun allPagesSentinelClampsWithoutIntegerOverflow(){assertEquals((0..12).toList(),PdfOutputPages.resolve(13,listOf(PdfOutputRange(0,Int.MAX_VALUE))))}
 @Test fun nonContiguousOriginalIndicesRemainOriginalInReceipt(){assertEquals(listOf(PdfOutputRange(1,3),PdfOutputRange(7,7)),PdfOutputPages.compact(listOf(1,2,3,7)))}
 @Test fun outsideAndEmptyRangesCannotReportSuccessfulEmptyOutput(){assertThrows(IllegalArgumentException::class.java){PdfOutputPages.resolve(13,listOf(PdfOutputRange(13,19)))};assertThrows(IllegalArgumentException::class.java){PdfOutputPages.resolve(13,emptyList())}}
 @Test fun invalidOrAmbiguousPageListsAreRejected(){assertThrows(IllegalArgumentException::class.java){PdfOutputPages.compact(listOf(1,1))};assertThrows(IllegalArgumentException::class.java){PdfOutputPages.compact(listOf(2,1))};assertThrows(IllegalArgumentException::class.java){PdfOutputRange(-1,0)};assertThrows(IllegalArgumentException::class.java){PdfOutputRange(3,2)}}
}
