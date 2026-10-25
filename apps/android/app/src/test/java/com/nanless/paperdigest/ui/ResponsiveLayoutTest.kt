package com.nanless.paperdigest.ui

import org.junit.Assert.*
import org.junit.Test

class ResponsiveLayoutTest {
 @Test fun noPdfNeverInventsAnEmptySecondPane(){for(width in listOf(320f,360f,600f,840f,1280f,2000f))assertFalse(readerGeometry(width,700f,1f,false,46f).canSplit)}
 @Test fun actualPaneWidthsRemainReadableAt200PercentFont(){
  for(scale in listOf(1f,1.3f,1.5f,2f))for(width in listOf(320f,360f,600f,840f,960f,972f,1280f))for(saved in listOf(-3f,38f,46f,54f,62f,150f,Float.NaN)){
   val value=readerGeometry(width,700f,scale,true,saved)
   assertTrue(value.leftPercent.isFinite())
   if(value.canSplit){assertTrue((width-12f)*value.leftPercent/100f>=value.minimumPaneDp-.01f);assertTrue((width-12f)*(100f-value.leftPercent)/100f>=value.minimumPaneDp-.01f)}
  }
  assertFalse(readerGeometry(600f,800f,1f,true,46f).canSplit)
  assertFalse(readerGeometry(840f,800f,2f,true,46f).canSplit)
 }
 @Test fun flexibleNonOccludingFoldRetainsTheWholeWindow(){assertEquals(ViewportRegion(0f,0f,1000f,800f),nonOccludingRegion(1000f,800f,listOf(ViewportHinge(true,500f,500f))))}
 @Test fun realVerticalHingeUsesBothReadablePanelsOnlyWhenPdfIsOpen(){
  val safe=nonOccludingRegions(1000f,800f,listOf(ViewportHinge(true,490f,510f)))
  val pair=readingHingePair(safe,2f,true)!!
  assertEquals(ViewportRegion(0f,0f,484f,800f),pair.left);assertEquals(ViewportRegion(516f,0f,1000f,800f),pair.right)
  assertNull(readingHingePair(safe,1f,false))
  assertNull(readingHingePair(nonOccludingRegions(800f,800f,listOf(ViewportHinge(true,390f,410f))),2f,true))
  assertNotNull(readingHingePair(nonOccludingRegions(800f,800f,listOf(ViewportHinge(true,390f,410f))),1f,true))
  assertNull(readingHingePair(nonOccludingRegions(1000f,250f,listOf(ViewportHinge(true,490f,510f))),2f,true))
 }
 @Test fun safeSingleAndTabletopRegionsNeverCrossThePhysicalGap(){
  assertEquals(ViewportRegion(0f,0f,484f,800f),nonOccludingRegion(1000f,800f,listOf(ViewportHinge(true,490f,510f))))
  assertEquals(ViewportRegion(0f,0f,1000f,384f),nonOccludingRegion(1000f,800f,listOf(ViewportHinge(false,390f,410f))))
 }
}
