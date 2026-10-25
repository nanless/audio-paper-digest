package com.nanless.paperdigest.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.material3.adaptive.currentWindowAdaptiveInfoV2
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp

internal val LocalHingeConstrained=compositionLocalOf{false}
internal val LocalReadingHingePair=compositionLocalOf<ReadingHingePair?>{null}
internal val LocalReadingHingePairAvailable=compositionLocalOf{false}

/** Actual window hinge bounds are transformed to this inset-consumed content root. */
@Composable internal fun NonOccludingViewport(
 allowHingePair:Boolean=false,
 preferHingePair:Boolean=true,
 preferRightRegion:Boolean=false,
 content:@Composable BoxWithConstraintsScope.()->Unit
){
 val density=LocalDensity.current
 val posture=currentWindowAdaptiveInfoV2().windowPosture
 var origin by remember{mutableStateOf<Offset?>(null)}
 BoxWithConstraints(Modifier.fillMaxSize().onGloballyPositioned{origin=it.positionInWindow()}){
  val exclusions=remember(posture,origin,density.density,maxWidth,maxHeight){
   val start=origin
   if(start==null)emptyList()else posture.hingeList.filter{it.isSeparating||it.isOccluding}.mapNotNull{hinge->
    val bounds=hinge.bounds
    val left=(bounds.left-start.x)/density.density;val right=(bounds.right-start.x)/density.density
    val top=(bounds.top-start.y)/density.density;val bottom=(bounds.bottom-start.y)/density.density
    // A non-occluding flexible fold has zero thickness: it must not waste half the screen.
    if(hinge.isVertical){if(right<=left||bottom<0f||top>maxHeight.value)null else ViewportHinge(true,left,right)}
    else{if(bottom<=top||right<0f||left>maxWidth.value)null else ViewportHinge(false,top,bottom)}
   }
  }
  val regions=remember(maxWidth,maxHeight,exclusions){nonOccludingRegions(maxWidth.value,maxHeight.value,exclusions)}
  val availablePair=remember(regions,density.fontScale,allowHingePair){readingHingePair(regions,density.fontScale,allowHingePair)}
  val activePair=availablePair.takeIf{preferHingePair}
  val focusedRegion=availablePair?.let{if(preferRightRegion)it.right else it.left}
  val region=activePair?.envelope?:focusedRegion?:regions.maxWithOrNull(compareBy<ViewportRegion>{it.width*it.height}.thenBy{-it.left}.thenBy{-it.top})?:ViewportRegion(0f,0f,0f,0f)
  val constrained=exclusions.isNotEmpty()&&(region.left>0f||region.top>0f||region.width<maxWidth.value||region.height<maxHeight.value||activePair!=null)
  CompositionLocalProvider(LocalHingeConstrained provides constrained,LocalReadingHingePair provides activePair,LocalReadingHingePairAvailable provides (availablePair!=null)){
   if(region.width<1f||region.height<1f)Text("请展开窗口或调整折叠姿态后继续阅读。原资料仍保留。")
   else BoxWithConstraints(Modifier.offset(region.left.dp,region.top.dp).width(region.width.dp).height(region.height.dp)){content()}
  }
 }
}
