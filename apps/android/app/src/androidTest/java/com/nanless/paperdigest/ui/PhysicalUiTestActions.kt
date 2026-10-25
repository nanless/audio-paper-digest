package com.nanless.paperdigest.ui

import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2

/** Actual system input. Traverse to the real clickable owner, including disabled ancestors. */
internal object PhysicalUiTestActions {
 fun target(node:UiObject2):UiObject2 {
  var cursor:UiObject2?=node
  repeat(12){val current=requireNotNull(cursor){"No actual clickable owner for this visible control"};require(current.isEnabled){"Actual control or its ancestor is disabled"};if(current.isClickable)return current;cursor=current.parent}
  error("No bounded actual clickable owner for this control")
 }
 fun clickVisible(device:UiDevice,label:String,density:Float){
  require(device.currentPackageName=="com.nanless.paperdigest")
  val node=requireNotNull(device.findObject(By.text(label).pkg("com.nanless.paperdigest"))){"Actual control missing: $label"};val owner=target(node);val bounds=owner.visibleBounds
  require(!node.visibleBounds.isEmpty&&!bounds.isEmpty){"Actual clickable control is not visible: $label"}
  println("PD_PHYSICAL_ACTION label=$label textBounds=${node.visibleBounds} ownerBounds=$bounds ownerClass=${owner.className}");owner.click()
 }
 fun popupItem(device:UiDevice,label:String,density:Float){
  require(device.currentPackageName=="com.nanless.paperdigest")
  val anchor=requireNotNull(device.findObject(By.text("论文完整信息与来源…").pkg("com.nanless.paperdigest"))){"Actual paper menu was not open"};val x=anchor.visibleBounds.centerX();require(x in 1 until device.displayWidth)
  for(attempt in 0..7){
   val item=device.findObject(By.text(label).pkg("com.nanless.paperdigest"))
   if(item!=null&&!item.visibleBounds.isEmpty){val owner=target(item);val rect=owner.visibleBounds;println("PD_PHYSICAL_MENU label=$label attempt=$attempt textBounds=${item.visibleBounds} ownerBounds=$rect ownerClass=${owner.className}");if(!rect.isEmpty&&rect.top>=0&&rect.bottom<device.displayHeight-(24*density).toInt()){owner.click();return}}
   if(attempt<7){require(device.currentPackageName=="com.nanless.paperdigest");device.swipe(x,(device.displayHeight*.78).toInt(),x,(device.displayHeight*.28).toInt(),24);device.waitForIdle(1000)}
  }
  error("Actual paper-menu item did not become visibly actionable after bounded physical scrolling: $label")
 }
 fun pendingOriginal(device:UiDevice,name:String,otherNames:List<String>){
  require(device.currentPackageName=="com.nanless.paperdigest")
  for(attempt in 0..35){
   val title=device.findObject(By.text(name).pkg("com.nanless.paperdigest"));var parent=title?.parent
   repeat(10){
    val box=parent
    if(box!=null){val buttons=box.findObjects(By.text("继续保存原件"));if(buttons.size==1){val button=buttons.single();if(!button.visibleBounds.isEmpty){val owner=target(button);val rect=owner.visibleBounds;if(!rect.isEmpty&&rect.centerY() in (device.displayHeight*.15).toInt()..(device.displayHeight*.72).toInt()){println("PD_PENDING_ORIGINAL matchedExactName=true ownerBounds=$rect");owner.click();return}}};parent=box.parent}
   }
   // Some Compose semantics-only card containers are deliberately flattened in native AX.
   // In that case bind the button to this exact visible title and reject any intervening other card title.
   if(title!=null&&!title.visibleBounds.isEmpty){
    val titleRect=title.visibleBounds
    val candidates=device.findObjects(By.text("继续保存原件").pkg("com.nanless.paperdigest")).filter{!it.visibleBounds.isEmpty&&it.visibleBounds.top>=titleRect.bottom}.sortedBy{it.visibleBounds.top}
    val button=candidates.firstOrNull()
    if(button!=null){val owner=target(button);val rect=owner.visibleBounds;val intervening=otherNames.filter{it!=name}.mapNotNull{device.findObject(By.text(it).pkg("com.nanless.paperdigest"))?.visibleBounds}.any{!it.isEmpty&&it.top>titleRect.bottom&&it.top<rect.top}
     if(!intervening&&!rect.isEmpty&&rect.centerY() in (device.displayHeight*.15).toInt()..(device.displayHeight*.72).toInt()){println("PD_PENDING_ORIGINAL exactVisibleTitle=true noInterveningCard=true ownerBounds=$rect");owner.click();return}
    }
   }
   if(attempt<35){device.swipe(device.displayWidth/2,(device.displayHeight*.72).toInt(),device.displayWidth/2,(device.displayHeight*.57).toInt(),80);device.waitForIdle(1000)}
  }
  error("The exact prepared original's save button was not physically reachable")
 }
}
