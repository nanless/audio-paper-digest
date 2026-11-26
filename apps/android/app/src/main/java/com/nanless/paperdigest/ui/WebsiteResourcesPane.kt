package com.nanless.paperdigest.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.nanless.paperdigest.data.CatalogRepository
import org.json.JSONObject

/** Website destinations are explicitly external; typed aggregate readers keep their native source guards. */
internal val websiteDestinations=listOf(
    "首页" to "",
    "论文库" to "papers/",
    "搜索" to "search/",
    "归档" to "archives/",
    "研究方向" to "tags/",
    "专题导航" to "hubs/",
    "会议论文集" to "conferences/",
    "关于" to "about/",
    "资源" to "links/",
    "RSS 订阅" to "index.xml",
)
@Composable internal fun WebsiteResourcesPane(state:UiState,action:Action){
    val context=LocalContext.current;var error by remember{mutableStateOf<String?>(null)}
    NonOccludingViewport{Box(Modifier.fillMaxSize(),contentAlignment=Alignment.TopCenter){LazyColumn(Modifier.widthIn(max=820.dp).fillMaxHeight(),contentPadding=PaddingValues(20.dp),verticalArrangement=Arrangement.spacedBy(12.dp)){
        item("heading"){Row(verticalAlignment=Alignment.CenterVertically){IconButton({action("ui.library",JSONObject())}){Icon(Icons.Outlined.ArrowBack,"返回论文库")};Column(Modifier.weight(1f)){Text("网站全部成果",style=MaterialTheme.typography.headlineSmall);Text("从研究方向，到每一次更新",style=MaterialTheme.typography.bodyMedium,color=MaterialTheme.colorScheme.onSurfaceVariant)}}}
        error?.let{item("error"){Text(it,color=MaterialTheme.colorScheme.error)}}
        item("native") {Text("在工作台阅读",style=MaterialTheme.typography.titleSmall,color=MaterialTheme.colorScheme.primary,modifier=Modifier.padding(top=6.dp))}
        item("directions"){ResourceCard("研究方向","完整九维目录 · ${state.websiteTaxonomy?.nodes?.size?:0} 个方向",Icons.Outlined.AccountTree,MaterialTheme.colorScheme.primaryContainer,MaterialTheme.colorScheme.onPrimaryContainer){action("ui.library.directory",JSONObject())}}
        item("daily"){ResourceCard("每日音频研究","已发布日更、历史更新与逐篇导读",Icons.Outlined.Today,MaterialTheme.colorScheme.primaryContainer,MaterialTheme.colorScheme.onPrimaryContainer){action("ui.aggregates",obj("section" to "daily"))}}
        item("conferences"){ResourceCard("会议论文集","会议总览、研究专题与论文",Icons.Outlined.Groups,MaterialTheme.colorScheme.tertiaryContainer,MaterialTheme.colorScheme.onTertiaryContainer){action("ui.aggregates",obj("section" to "conference"))}}
        item("pages"){ResourceCard("关于与研究资源","阅读网站说明、工具与研究链接",Icons.Outlined.Language,MaterialTheme.colorScheme.secondaryContainer,MaterialTheme.colorScheme.onSecondaryContainer){action("ui.aggregates",obj("section" to "page"))}}
        item("website") {Column(Modifier.padding(top=10.dp),verticalArrangement=Arrangement.spacedBy(3.dp)){Text("完整网站",style=MaterialTheme.typography.titleSmall,color=MaterialTheme.colorScheme.primary);Text("以下入口在浏览器打开官网，包含专题导航、网页搜索、归档与订阅。",style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant)}}
        items(websiteDestinations,key={it.first}){(label,path)->
            OutlinedCard(
                onClick={try{val url=CatalogRepository.sameSite(CatalogRepository.SITE+path);context.startActivity(Intent(Intent.ACTION_VIEW,Uri.parse(url)))}catch(_:Exception){error="此设备没有可打开网站的应用。"}},
                colors=CardDefaults.outlinedCardColors(containerColor=MaterialTheme.colorScheme.surfaceContainerLowest),
                border=BorderStroke(1.dp,MaterialTheme.colorScheme.outlineVariant.copy(alpha=0.72f)),
                shape=MaterialTheme.shapes.small,
                modifier=Modifier.fillMaxWidth(),
            ){
                Row(Modifier.padding(horizontal=16.dp,vertical=13.dp),verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(12.dp)){
                    Surface(
                        color=if(path=="hubs/")MaterialTheme.colorScheme.tertiaryContainer else MaterialTheme.colorScheme.surfaceContainer,
                        shape=MaterialTheme.shapes.extraSmall,
                    ) {
                        Icon(
                            if(path=="hubs/")Icons.Outlined.Explore else if(path=="index.xml")Icons.Outlined.RssFeed else Icons.Outlined.Public,
                            null,
                            Modifier.padding(6.dp).size(16.dp),
                            tint=if(path=="hubs/")MaterialTheme.colorScheme.onTertiaryContainer else MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Text(label,Modifier.weight(1f),style=MaterialTheme.typography.bodyMedium,fontWeight=FontWeight.Medium)
                    Icon(Icons.Outlined.OpenInNew,"在浏览器打开官网$label",Modifier.size(18.dp),tint=MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }}}
}
@Composable private fun ResourceCard(
    title:String,
    subtitle:String,
    icon:androidx.compose.ui.graphics.vector.ImageVector,
    iconBg:Color,
    iconFg:Color,
    click:()->Unit,
){
    Card(
        onClick=click,
        colors=CardDefaults.cardColors(containerColor=MaterialTheme.colorScheme.surfaceContainerLowest),
        border=BorderStroke(1.dp,MaterialTheme.colorScheme.outlineVariant.copy(alpha=0.72f)),
        shape=MaterialTheme.shapes.medium,
        modifier=Modifier.fillMaxWidth(),
    ){
        Row(Modifier.padding(16.dp),verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(14.dp)){
            Surface(color=iconBg,shape=MaterialTheme.shapes.small){Icon(icon,null,Modifier.padding(10.dp).size(22.dp),tint=iconFg)}
            Column(Modifier.weight(1f),verticalArrangement=Arrangement.spacedBy(3.dp)){Text(title,style=MaterialTheme.typography.titleMedium,fontWeight=FontWeight.SemiBold);Text(subtitle,style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant,maxLines=2,overflow=TextOverflow.Ellipsis)}
            Icon(Icons.Outlined.ChevronRight,null,Modifier.size(18.dp),tint=MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}
