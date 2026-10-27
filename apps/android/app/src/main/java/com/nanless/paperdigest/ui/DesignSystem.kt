package com.nanless.paperdigest.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import com.nanless.paperdigest.data.Paper

@Composable internal fun PaperPanel(modifier:Modifier=Modifier,content:@Composable ColumnScope.()->Unit) {
    Surface(modifier=modifier.fillMaxWidth(),shape=MaterialTheme.shapes.large,
        color=MaterialTheme.colorScheme.surfaceContainerLow,
        border=BorderStroke(1.dp,MaterialTheme.colorScheme.outlineVariant.copy(alpha=0.55f))) {
        Column(Modifier.padding(18.dp),verticalArrangement=Arrangement.spacedBy(12.dp),content=content)
    }
}

@Composable internal fun PaperLabel(text:String,icon:ImageVector?=null,emphasized:Boolean=false) {
    Surface(shape=MaterialTheme.shapes.small,
        color=if(emphasized)MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainer,
        contentColor=if(emphasized)MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurfaceVariant) {
        Row(Modifier.padding(horizontal=9.dp,vertical=5.dp),verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(5.dp)) {
            if(icon!=null)Icon(icon,null,Modifier.size(14.dp))
            Text(text,style=MaterialTheme.typography.labelMedium,maxLines=2,overflow=TextOverflow.Ellipsis)
        }
    }
}

@Composable internal fun SettingsCategoryIcon(label:String) {
    Icon(when(label){
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
    val icon=when {
        running->Icons.Outlined.Schedule
        failed->Icons.Outlined.ErrorOutline
        status in setOf("completed","complete")->Icons.Outlined.CheckCircleOutline
        else->Icons.Outlined.PauseCircleOutline
    }
    if(failed)Surface(shape=MaterialTheme.shapes.small,color=MaterialTheme.colorScheme.errorContainer,contentColor=MaterialTheme.colorScheme.onErrorContainer) {
        Row(Modifier.padding(horizontal=9.dp,vertical=5.dp),verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(5.dp)) {
            Icon(icon,null,Modifier.size(14.dp));Text(jobStatus(status),style=MaterialTheme.typography.labelMedium)
        }
    } else PaperLabel(jobStatus(status),icon,running)
}
