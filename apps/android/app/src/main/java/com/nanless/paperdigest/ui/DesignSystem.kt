package com.nanless.paperdigest.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import com.nanless.paperdigest.data.Paper

@Composable internal fun PaperPanel(modifier:Modifier=Modifier,content:@Composable ColumnScope.()->Unit) {
    Surface(
        modifier=modifier.fillMaxWidth(),
        shape=MaterialTheme.shapes.large,
        color=MaterialTheme.colorScheme.surfaceContainerLowest,
        border=BorderStroke(1.dp,MaterialTheme.colorScheme.outlineVariant.copy(alpha=0.72f)),
    ) {
        Column(Modifier.padding(18.dp),verticalArrangement=Arrangement.spacedBy(12.dp),content=content)
    }
}

@Composable internal fun EditorialCard(
    modifier:Modifier=Modifier,
    onClick:(()->Unit)?=null,
    enabled:Boolean=true,
    selected:Boolean=false,
    content:@Composable ColumnScope.()->Unit,
) {
    val container=if(selected)MaterialTheme.colorScheme.primaryContainer.copy(alpha=0.28f) else MaterialTheme.colorScheme.surfaceContainerLowest
    val borderColor=if(selected)MaterialTheme.colorScheme.primary.copy(alpha=0.65f) else MaterialTheme.colorScheme.outlineVariant.copy(alpha=0.72f)
    val cardBorder=BorderStroke(1.dp,borderColor)
    val inner:@Composable ()->Unit = {
        Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min)) {
            if(selected) Box(Modifier.width(3.dp).fillMaxHeight().background(MaterialTheme.colorScheme.primary))
            Column(Modifier.weight(1f).padding(16.dp),verticalArrangement=Arrangement.spacedBy(8.dp),content=content)
        }
    }
    if(onClick!=null) {
        Card(
            onClick=onClick,
            enabled=enabled,
            modifier=modifier.fillMaxWidth(),
            shape=MaterialTheme.shapes.medium,
            colors=CardDefaults.cardColors(containerColor=container),
            border=cardBorder,
        ) { inner() }
    } else {
        Surface(
            modifier=modifier.fillMaxWidth(),
            shape=MaterialTheme.shapes.medium,
            color=container,
            border=cardBorder,
        ) { inner() }
    }
}

@Composable internal fun SectionCard(
    title:String,
    modifier:Modifier=Modifier,
    subtitle:String?=null,
    icon:ImageVector?=null,
    content:@Composable ColumnScope.()->Unit,
) {
    Surface(
        modifier=modifier.fillMaxWidth(),
        shape=MaterialTheme.shapes.medium,
        color=MaterialTheme.colorScheme.surfaceContainerLow,
        border=BorderStroke(1.dp,MaterialTheme.colorScheme.outlineVariant.copy(alpha=0.72f)),
    ) {
        Column(Modifier.padding(16.dp),verticalArrangement=Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(10.dp)) {
                if(icon!=null) {
                    Surface(
                        shape=MaterialTheme.shapes.small,
                        color=MaterialTheme.colorScheme.primaryContainer,
                        border=BorderStroke(1.dp,MaterialTheme.colorScheme.primary.copy(alpha=0.16f)),
                    ) {
                        Icon(icon,null,Modifier.padding(8.dp).size(18.dp),tint=MaterialTheme.colorScheme.onPrimaryContainer)
                    }
                }
                Column(Modifier.weight(1f),verticalArrangement=Arrangement.spacedBy(2.dp)) {
                    Text(title,style=MaterialTheme.typography.titleMedium,fontWeight=FontWeight.SemiBold)
                    subtitle?.let { Text(it,style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant) }
                }
            }
            HorizontalDivider(color=MaterialTheme.colorScheme.outlineVariant.copy(alpha=0.55f))
            content()
        }
    }
}

@Composable internal fun StatePanel(
    title:String,
    text:String,
    modifier:Modifier=Modifier,
    icon:ImageVector=Icons.Outlined.AutoStories,
    actionLabel:String?=null,
    onAction:(()->Unit)?=null,
) {
    Surface(
        modifier=modifier.fillMaxWidth(),
        shape=MaterialTheme.shapes.large,
        color=MaterialTheme.colorScheme.surfaceContainerLow,
        border=BorderStroke(1.dp,MaterialTheme.colorScheme.outlineVariant.copy(alpha=0.65f)),
    ) {
        Column(Modifier.fillMaxWidth().padding(horizontal=24.dp,vertical=32.dp),verticalArrangement=Arrangement.spacedBy(12.dp)) {
            Surface(
                shape=CircleShape,
                color=MaterialTheme.colorScheme.primaryContainer,
                border=BorderStroke(1.dp,MaterialTheme.colorScheme.primary.copy(alpha=0.22f)),
            ) {
                Icon(icon,null,Modifier.padding(16.dp).size(26.dp),tint=MaterialTheme.colorScheme.onPrimaryContainer)
            }
            Text(title,style=MaterialTheme.typography.titleLarge,fontWeight=FontWeight.SemiBold)
            Text(text,color=MaterialTheme.colorScheme.onSurfaceVariant,style=MaterialTheme.typography.bodyMedium)
            if(actionLabel!=null&&onAction!=null) {
                FilledTonalButton(onClick=onAction) { Text(actionLabel) }
            }
        }
    }
}

@Composable internal fun MonographPill(
    text:String,
    containerColor:Color,
    contentColor:Color,
    icon:ImageVector?=null,
    borderColor:Color?=null,
) {
    Surface(
        shape=MaterialTheme.shapes.extraSmall,
        color=containerColor,
        contentColor=contentColor,
        border=borderColor?.let{BorderStroke(1.dp,it)},
    ) {
        Row(
            Modifier.padding(horizontal=7.dp,vertical=3.dp),
            verticalAlignment=Alignment.CenterVertically,
            horizontalArrangement=Arrangement.spacedBy(4.dp),
        ) {
            if(icon!=null)Icon(icon,null,Modifier.size(13.dp))
            Text(text,style=MaterialTheme.typography.labelSmall,maxLines=1,overflow=TextOverflow.Ellipsis)
        }
    }
}

@Composable internal fun PaperLabel(text:String,icon:ImageVector?=null,emphasized:Boolean=false) {
    Surface(
        shape=MaterialTheme.shapes.extraSmall,
        color=if(emphasized)MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainer,
        contentColor=if(emphasized)MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurfaceVariant,
        border=BorderStroke(1.dp,if(emphasized)MaterialTheme.colorScheme.primary.copy(alpha=0.22f) else MaterialTheme.colorScheme.outlineVariant.copy(alpha=0.6f)),
    ) {
        Row(Modifier.padding(horizontal=9.dp,vertical=4.dp),verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(5.dp)) {
            if(icon!=null)Icon(icon,null,Modifier.size(14.dp))
            Text(text,style=MaterialTheme.typography.labelMedium,maxLines=2,overflow=TextOverflow.Ellipsis)
        }
    }
}

@Composable internal fun SettingsCategoryIcon(label:String) {
    Icon(when(label){
        "开始"->Icons.Outlined.Tune
        "阅读"->Icons.Outlined.MenuBook
        "模型"->Icons.Outlined.AutoAwesome
        "资料"->Icons.Outlined.FolderOpen
        "坚果云"->Icons.Outlined.CloudQueue
        "Zotero"->Icons.Outlined.Bookmarks
        else->Icons.Outlined.Info
    },null,Modifier.size(20.dp))
}

/** Display formatting changes neither original timestamps nor cross-device ordering. */
internal fun readableMoment(value:String):String = runCatching {
    DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm").withZone(ZoneId.systemDefault()).format(Instant.parse(value))
}.getOrDefault(value.ifBlank{"时间未记录"})

internal fun paperSourceLabel(paper:Paper):String = paper.sourceVersion?.takeIf{it.isNotBlank()} ?: when(paper.sourceKind){
    "arxiv"->"arXiv · 版本未标注"
    "conference"->"会议论文"
    "local"->"本地 PDF"
    else->"来源未标注"
}

@Composable internal fun StatusLabel(status:String) {
    val running=status in setOf("running","pending","queued")
    val failed=status in setOf("failed","interrupted")
    val done=status in setOf("completed","complete")
    val icon=when {
        running->Icons.Outlined.Schedule
        failed->Icons.Outlined.ErrorOutline
        done->Icons.Outlined.CheckCircleOutline
        else->Icons.Outlined.PauseCircleOutline
    }
    val (bg,fg,border)=when {
        failed->Triple(MaterialTheme.colorScheme.errorContainer,MaterialTheme.colorScheme.onErrorContainer,MaterialTheme.colorScheme.error.copy(alpha=0.25f))
        running->Triple(MaterialTheme.colorScheme.tertiaryContainer,MaterialTheme.colorScheme.onTertiaryContainer,MaterialTheme.colorScheme.tertiary.copy(alpha=0.28f))
        done->Triple(MaterialTheme.colorScheme.primaryContainer,MaterialTheme.colorScheme.onPrimaryContainer,MaterialTheme.colorScheme.primary.copy(alpha=0.22f))
        else->Triple(MaterialTheme.colorScheme.surfaceContainerHigh,MaterialTheme.colorScheme.onSurfaceVariant,MaterialTheme.colorScheme.outlineVariant.copy(alpha=0.6f))
    }
    Surface(shape=MaterialTheme.shapes.extraSmall,color=bg,contentColor=fg,border=BorderStroke(1.dp,border)) {
        Row(Modifier.padding(horizontal=9.dp,vertical=4.dp),verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(5.dp)) {
            Icon(icon,null,Modifier.size(14.dp));Text(jobStatus(status),style=MaterialTheme.typography.labelMedium)
        }
    }
}
