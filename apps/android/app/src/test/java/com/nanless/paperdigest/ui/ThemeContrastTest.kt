package com.nanless.paperdigest.ui
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import org.junit.Assert.assertTrue
import org.junit.Test
class ThemeContrastTest {
 @Test fun bothPalettesPreserveReadableActiveTextAndSelectedStates(){
  listOf(false,true).forEach{dark->val s=paperColorScheme(dark);listOf(s.onSurface to s.surface,s.onSurface to s.surfaceContainerLow,s.onSurfaceVariant to s.surface,s.onPrimary to s.primary,s.onPrimaryContainer to s.primaryContainer,s.onSecondaryContainer to s.secondaryContainer,s.primary to s.background).forEach{(foreground,background)->assertTrue("Active text contrast below 4.5 in dark=$dark",contrast(foreground,background)>=4.5)}}
 }
 private fun contrast(a:Color,b:Color):Double {val x=a.luminance().toDouble();val y=b.luminance().toDouble();return (maxOf(x,y)+.05)/(minOf(x,y)+.05)}
}
