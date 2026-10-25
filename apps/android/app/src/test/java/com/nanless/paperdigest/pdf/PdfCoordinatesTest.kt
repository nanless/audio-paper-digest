package com.nanless.paperdigest.pdf
import org.junit.Assert.*
import org.junit.Test
class PdfCoordinatesTest {
 @Test fun fourRotationsNonzeroCropRoundTripInPhysicalPdfPoints(){
  for(rotation in listOf(0,90,180,270)){
   val g=PdfPageGeometry(37f,53f,200f,300f,rotation);val original=PdfUserRect(77f,153f,40f,12f)
   val displayed=PdfCoordinates.toDisplaySpace(5,original,g);val restored=PdfCoordinates.toUserSpace(displayed,g)
   assertEquals(5,displayed.page);assertEquals(original,restored)
  }
 }
 @Test fun explicitExpectedCornersPreventSymmetricWrongTransformsPassingRoundTrip(){
  val r=PdfUserRect(77f,153f,40f,12f)
  val expected=listOf(PdfSelectionBounds(1,40f,188f,80f,200f),PdfSelectionBounds(1,100f,40f,112f,80f),PdfSelectionBounds(1,120f,100f,160f,112f),PdfSelectionBounds(1,188f,120f,200f,160f))
  for((i,rotation) in listOf(0,90,180,270).withIndex())assertEquals(expected[i],PdfCoordinates.toDisplaySpace(1,r,PdfPageGeometry(37f,53f,200f,300f,rotation)))
 }
 @Test fun nonFiniteOrUnsupportedGeometryRejects(){for(r in listOf(1,45,360))assertThrows(IllegalArgumentException::class.java){PdfPageGeometry(0f,0f,200f,300f,r)};assertThrows(IllegalArgumentException::class.java){PdfCoordinates.toUserSpace(PdfSelectionBounds(1,Float.NaN,0f,1f,1f),PdfPageGeometry(0f,0f,200f,300f,0))}}
}
