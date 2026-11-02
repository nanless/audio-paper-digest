package com.nanless.paperdigest.ui

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Remove
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable

/** Shares the persisted reading scale with Settings, without replacing the current document. */
@Composable internal fun ReaderTextSizeMenu(fontSize:Int,onChange:(Int)->Unit){
    val current=fontSize.coerceIn(14,30)
    DropdownMenuItem(text={Text("缩小文字")},leadingIcon={Icon(Icons.Outlined.Remove,null)},enabled=current>14,onClick={onChange((current-2).coerceAtLeast(14))})
    DropdownMenuItem(text={Text("放大文字")},leadingIcon={Icon(Icons.Outlined.Add,null)},enabled=current<30,onClick={onChange((current+2).coerceAtMost(30))})
    DropdownMenuItem(text={Text("恢复默认文字大小")},enabled=current!=18,onClick={onChange(18)})
}
