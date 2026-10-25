package com.nanless.paperdigest.ui

/** Policies use the available, already inset-consumed viewport, never a device model. */
internal data class ReaderGeometry(val canSplit:Boolean,val compactChrome:Boolean,val leftPercent:Float,val minPercent:Float,val maxPercent:Float,val minimumPaneDp:Float)
internal fun readerMinimumPane(fontScale:Float):Float {
 val scale=fontScale.takeIf{it.isFinite()&&it>0f}?:1f
 return 360f+120f*(scale-1f).coerceIn(0f,1f)
}
internal fun readerGeometry(widthDp:Float,heightDp:Float,fontScale:Float,pdfAvailable:Boolean,preferredSplit:Float):ReaderGeometry {
 val width=widthDp.takeIf{it.isFinite()&&it>0f}?:0f
 val height=heightDp.takeIf{it.isFinite()&&it>0f}?:0f
 val scale=fontScale.takeIf{it.isFinite()&&it>0f}?:1f
 val pane=readerMinimumPane(scale)
 val usable=(width-12f).coerceAtLeast(0f)
 val canSplit=pdfAvailable&&width>=840f&&usable>=pane*2f
 val minimum=if(canSplit)maxOf(38f,100f*pane/usable)else 38f
 val maximum=if(canSplit)minOf(62f,100f*(1f-pane/usable))else 62f
 val preferred=preferredSplit.takeIf{it.isFinite()}?:46f
 return ReaderGeometry(canSplit,height<480f||width<360f||scale>=1.5f,preferred.coerceIn(minimum,maximum),minimum,maximum,pane)
}

internal data class ViewportRegion(val left:Float,val top:Float,val right:Float,val bottom:Float){
 val width get()=(right-left).coerceAtLeast(0f)
 val height get()=(bottom-top).coerceAtLeast(0f)
}
/** Only real positive-area occlusion/separation enters this list; a flexible zero-width fold does not. */
internal data class ViewportHinge(val vertical:Boolean,val start:Float,val end:Float)
internal fun nonOccludingRegions(widthDp:Float,heightDp:Float,hinges:List<ViewportHinge>):List<ViewportRegion> {
 val width=widthDp.takeIf{it.isFinite()&&it>0f}?:0f;val height=heightDp.takeIf{it.isFinite()&&it>0f}?:0f
 var regions=listOf(ViewportRegion(0f,0f,width,height))
 for(h in hinges){
  if(!h.start.isFinite()||!h.end.isFinite()||h.end<=h.start)continue
  val low=h.start-6f;val high=h.end+6f
  regions=regions.flatMap{r->
   if(h.vertical){if(high<=r.left||low>=r.right)listOf(r)else listOf(ViewportRegion(r.left,r.top,low.coerceIn(r.left,r.right),r.bottom),ViewportRegion(high.coerceIn(r.left,r.right),r.top,r.right,r.bottom))}
   else{if(high<=r.top||low>=r.bottom)listOf(r)else listOf(ViewportRegion(r.left,r.top,r.right,low.coerceIn(r.top,r.bottom)),ViewportRegion(r.left,high.coerceIn(r.top,r.bottom),r.right,r.bottom))}
  }.filter{it.width>0f&&it.height>0f}
 }
 return regions.filter{it.width>0f&&it.height>0f}
}
internal fun nonOccludingRegion(widthDp:Float,heightDp:Float,hinges:List<ViewportHinge>):ViewportRegion =
 nonOccludingRegions(widthDp,heightDp,hinges).maxWithOrNull(compareBy<ViewportRegion>{it.width*it.height}.thenBy{-it.left}.thenBy{-it.top})?:ViewportRegion(0f,0f,0f,0f)

internal data class ReadingHingePair(val left:ViewportRegion,val right:ViewportRegion){
 val envelope get()=ViewportRegion(left.left,left.top,right.right,right.bottom)
 val gap get()=right.left-left.right
}
/** Physically separate screens are usable together only when BOTH panels remain readable. */
internal fun readingHingePair(regions:List<ViewportRegion>,fontScale:Float,pdfAvailable:Boolean):ReadingHingePair? {
 if(!pdfAvailable)return null
 val pane=readerMinimumPane(fontScale)
 val scale=fontScale.takeIf{it.isFinite()&&it>0f}?:1f
 val minimumHeight=200f*scale.coerceIn(1f,1.5f)
 return regions.flatMap{left->regions.mapNotNull{right->
  if(left.right+1f<right.left&&left.top==right.top&&left.bottom==right.bottom&&left.width>=pane&&right.width>=pane&&left.height>=minimumHeight&&regions.none{middle->middle!==left&&middle!==right&&middle.top==left.top&&middle.bottom==left.bottom&&middle.left>=left.right&&middle.right<=right.left})ReadingHingePair(left,right)else null
 }}.maxWithOrNull(compareBy<ReadingHingePair>{it.left.width*it.left.height+it.right.width*it.right.height}.thenBy{-it.left.top}.thenBy{-it.left.left})
}
